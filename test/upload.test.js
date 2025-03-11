// test/upload.test.js
import request from "supertest";
import { expect } from "chai";
import app from "../server.js"; // adjust the path to your main server file
import path from "path";
import { google } from "googleapis";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCOPES = [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/spreadsheets'
];
const auth = new google.auth.GoogleAuth({
    keyFile: './cv-pipeline-01-92372bcf22b4.json',
    scopes: SCOPES,
});
const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = '1c9CHuGUShXbJOumteOmA5L7ZLlVvLi6BenomVbNevN8';

async function getLastRow() {
    const range = "Sheet1!A:H";
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
    });
    const rows = result.data.values || [];
    if (rows.length === 0) {
        throw new Error("No rows found in the sheet");
    }
    return rows[rows.length - 1]; // Return the last row
}


it("should append data to Google Sheet", async function () {
    // ... (upload test code as above)
    const lastRow = await getLastRow();
    console.log("Last row in sheet:", lastRow);
    // Example check: verify the first column (name) is not empty
    expect(lastRow[0]).to.be.a("string").and.not.empty;
});

describe("POST /upload", function () {
    // Increase timeout if the Google API calls are slow
    this.timeout(15000);

    it("should process the file and update Google Sheets", async function () {
        const testFilePath = path.join(__dirname, "..", "src", "assets", "test_cv.pdf");

        const response = await request(app)
            .post("/upload")
            .attach("file", testFilePath)
            .expect(200);

        // Check that the response contains the expected keys
        expect(response.body).to.have.property("message");
        expect(response.body).to.have.property("fileId");
        expect(response.body).to.have.property("extractedData");
        expect(response.body).to.have.property("sheetResponse");

        // Optionally, check specific values if you know what to expect from your test file
        // For example:
        expect(response.body.extractedData).to.have.property("name");
        expect(response.body.extractedData.name).to.be.a("string");

        // You might also log the response to manually verify the payload:
        console.log("Test response:", response.body);
    });
});
