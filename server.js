import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import multer from "multer";
import path from "path";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";
import axios from "axios";
import { google } from "googleapis";
import stream from "stream";
import fs from "fs";
import nodemailer from "nodemailer";
import schedule from "node-schedule";

const app = express();
const PORT = 5000;

app.use(cors());
app.use(bodyParser.json());

// Use memory storage so that we can work directly with the file buffer
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Google Drive authentication using service account
const SCOPES = [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/spreadsheets"
];
const auth = new google.auth.GoogleAuth({
    keyFile: "./cv-pipeline-01-e5f9b9a2b1be.json", // Update with your credentials file path
    scopes: SCOPES
});

const drive = google.drive({ version: "v3", auth });
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = "1c9CHuGUShXbJOumteOmA5L7ZLlVvLi6BenomVbNevN8"; // Replace with your target spreadsheet ID

/**
 * Extracts CV data by splitting text into lines and grouping by section labels.
 * Assumes that personal info appears before the first label.
 */
const extractCVData = (text) => {
    try {
        const data = {};

        // Define the list of known labels (all in lowercase)
        // You can add synonyms or variations here as needed.
        const labelList = [
            "summary",
            "projects",
            "techinal skills",
            "technical skills",
            "experience",
            "soft skills",
            "education",
            "achievements",
            "participation",
            "references"
        ];

        // Split text into non-empty, trimmed lines
        const lines = text.split("\n").map(line => line.trim()).filter(line => line);

        // Find the index of the first occurrence of any label.
        let firstLabelIndex = lines.findIndex(line =>
            labelList.some(label => line.toLowerCase().startsWith(label))
        );

        // Use the lines before the first label as personal info.
        const personalInfoLines =
            firstLabelIndex > 0 ? lines.slice(0, firstLabelIndex) : [];

        // Assume the first line of personal info is the candidate's name.
        if (personalInfoLines.length > 0) {
            data.name = personalInfoLines[0];
        }
        // (Optional) You could store the remaining personal info in a separate field.
        data.personal_info =
            personalInfoLines.length > 1
                ? personalInfoLines.slice(1).join("\n")
                : "";

        // Extract email and phone using regex on the full text.
        const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
        const phonePattern = /\+?\d[\d\s\-]+/;
        const emailMatch = text.match(emailPattern);
        data.email = emailMatch ? emailMatch[0] : "";
        const phoneMatch = text.match(phonePattern);
        data.phone = phoneMatch ? phoneMatch[0] : "";

        // Process the lines starting from the first label.
        let currentLabel = "";
        for (let i = firstLabelIndex; i < lines.length; i++) {
            const line = lines[i];
            // Check if the line starts with any known label.
            const foundLabel = labelList.find(label =>
                line.toLowerCase().startsWith(label)
            );
            if (foundLabel) {
                // New section found. Set the current label.
                currentLabel = foundLabel;
                // Remove the label text from the line (and any following punctuation or spaces)
                const content = line.substring(foundLabel.length).replace(/^[:\-\s]+/, "");
                // Start this section’s content.
                data[currentLabel] = content;
            } else if (currentLabel) {
                // Append subsequent lines to the current section.
                data[currentLabel] += "\n" + line;
            }
        }

        // Trim whitespace from each extracted field.
        Object.keys(data).forEach((key) => {
            if (typeof data[key] === "string") {
                data[key] = data[key].trim();
            }
        });

        return data;
    } catch (error) {
        console.error("Error extracting CV data:", error);
        return { error: "Error extracting CV data", details: error.message };
    }
};
let fileName;

app.post("/upload", upload.single("file"), async (req, res) => {
    fileName = req.file.originalname;

    console.log("req.file:", req.file);
    if (!req.file) {
        return res.status(400).send("No files were uploaded.");
    }

    // try {
    const fileExtension = path.extname(req.file.originalname).toLowerCase();
    let fileData;

    if (fileExtension === ".docx") {
        const result = await mammoth.extractRawText({ buffer: req.file.buffer });
        fileData = result.value;
    } else if (fileExtension === ".pdf") {
        const pdfResult = await pdfParse(req.file.buffer);
        fileData = pdfResult.text;
    } else {
        return res.status(400).send("Unsupported file format");
    }

    console.log("Full extracted text:", fileData);
    const extractedData = extractCVData(fileData);
    console.log("Extracted data:", extractedData);

    // Convert the file buffer to a readable stream for Drive upload.
    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);

    const fileMetadata = {
        name: req.file.originalname,
        parents: ["1SyBij1koqegqOFZzG-sIJ4ZMLWkH-q9l"] // Google Drive folder ID
    };

    // Upload the file to Google Drive.
    const driveResponse = await drive.files.create({
        resource: fileMetadata,
        media: {
            mimeType: req.file.mimetype,
            body: bufferStream
        },
        fields: "id"
    });

    const driveFileId = driveResponse.data.id;
    console.log("Google Drive File Id:", driveFileId);

    // Set the file's permission to public (anyone with the link can view)
    await drive.permissions.create({
        fileId: driveFileId,
        resource: {
            role: 'reader',
            type: 'anyone'
        }
    });

    // Retrieve the file's public links
    const fileInfo = await drive.files.get({
        fileId: driveFileId,
        fields: 'id, webViewLink, webContentLink'
    });

    const downloadablePublicLink = fileInfo.data.webViewLink; // or use webContentLink for download
    console.log("Public link:", downloadablePublicLink);

    // Prepare payload for external API call.
    const payload = {
        "cv_data": {
            "personal_info": {
                name: extractedData.name || "",
                email: extractedData.email || "",
                phone: extractedData.phone || ""
            },
            "education": extractedData.education ? [extractedData.education] : [],
            "qualifications": extractedData.qualifications
                ? (Array.isArray(extractedData.qualifications)
                    ? extractedData.qualifications
                    : [extractedData.qualifications])
                : [],
            "projects": extractedData.projects ? [extractedData.projects] : [],
            "cv_public_link": downloadablePublicLink
        },
        "metadata": {
            "applicant_name": extractedData.name || "",
            "email": extractedData.email || "",
            "status": "prod",
            "cv_processed": true,
            "processed_timestamp": new Date().toISOString()
        }
    };
    // console.log("Payload for external API:", payload);

    let externalResult;

    try {
        const externalResponse = await axios.post(
            "https://rnd-assignment.automations-3d6.workers.dev/",
            // "https://httpbin.org/post", // Use this URL for testing
            payload,
            {
                headers: {
                    "Content-Type": "application/json",
                    "X-Candidate-Email": "ravijaanthony@gmail.com"
                }
            }
        );
        externalResult = externalResponse.data;
        console.log("External API response:", externalResponse.data);
        
    } catch (error) {
        console.error("Error sending payload to external endpoint:", error);
        externalResult = { error: "External API call failed", details: error.message };
    }

    // Define the desired order of fields for the Google Sheet.
    const orderedFields = [
        "name",
        "email",
        "phone",
        "summary",
        "projects",
        "experience",
        "education",
        "achievements",
        "references"
    ];

    // Build the values array based on the ordered fields.
    const values = [orderedFields.map(field => extractedData[field] || "")];

    const resource = { values };

    const sheetResponse = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "Sheet1!A1", // Change as needed
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        resource
    });

    console.log("Sheet update response:", sheetResponse.data);

    // Send the response back to the client.
    const candidateEmail = extractedData.email || "";
    if (candidateEmail) {
        console.log("Scheduling email to be sent to:", candidateEmail);

        const sendDate = new Date(2025, 2, 8, 14, 45, 0); // March 9, 2025, at 9:00 AM

        // Ensure sendDate is in the future
        if (sendDate > new Date()) {
            const transporter = nodemailer.createTransport({
                service: "gmail",
                auth: {
                    user: "service.test.services@gmail.com",
                    pass: "yfij yirp ybai hbtd"
                }
            });

            console.log("Transporter set");

            schedule.scheduleJob(sendDate, async function () {
                console.log("Scheduler triggered at:", new Date());

                const mailOptions = {
                    from: "service.test.services@gmail.com",
                    to: candidateEmail,
                    subject: "Your CV is Under Review",
                    text: `Dear ${extractedData.name || "Applicant"},
    
                    Thank you for submitting your CV. We wanted to let you know that your CV is currently under review. We will get back to you soon with more information.
    
                    Best regards,
                    Company`
                };

                console.log("Mail options set");

                try {
                    let info = await transporter.sendMail(mailOptions);
                    console.log("Email sent successfully:", info.response);
                } catch (error) {
                    console.error("Error sending email:", error);
                }
            });

            console.log("Job scheduled for:", sendDate);
        } else {
            console.error("Scheduled date is in the past. Please choose a future date.");
        }
    }


    res.json({
        message: "File processed successfully",
        fileId: driveFileId,
        extractedData,
        externalResult,
        sheetResponse: sheetResponse.data,
        downloadablePublicLink
    });
    //  );
});

app.get("/cv", async (req, res) => {
    try {
        // Replace the file path with the location of your PDF file if needed.
        const dataBuffer = fs.readFileSync(fileName);
        const data = await pdfParse(dataBuffer);
        const cvData = extractCVData(data.text);
        res.json(cvData);
    } catch (error) {
        res.status(500).json({ error: error.toString() });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

export default app;