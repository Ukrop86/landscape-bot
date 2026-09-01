import { google } from "googleapis";
import { config } from "../config.js";

export function getGoogleAuth() {
  const key = config.google.privateKey?.replace(/\\n/g, "\n");

  return new google.auth.JWT({
    email: config.google.clientEmail,
    key,
    // Drive is here because the same JWT signs the photo uploads in drive.ts.
    // Without it every upload came back 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT --
    // and since the odometer photo is optional, nobody noticed until object
    // photos made it a normal part of the day.
    scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"],
  });
}

export function getSheetsClient() {
  const auth = getGoogleAuth();
  return google.sheets({ version: "v4", auth });
}
