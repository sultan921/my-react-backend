const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();

const app = express();

// ==========================
// Middleware
// ==========================
app.use(express.json());
app.use(cors());

// ==========================
// Environment Variables & Port
// ==========================
const PORT = process.env.PORT || 8080;
const MONGO_URI = process.env.MONGO_URI;

// ==========================
// MongoDB Connection
// ==========================
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log("✅ Successfully connected to MongoDB Atlas");
  })
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err.message);
    process.exit(1); // Agar database connect na ho toh server rokh dein
  });

// ==========================
// Routes
// ==========================
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "🚀 Zeelop Backend is running successfully!",
  });
});

// ==========================
// Server Initialization
// ==========================
// Server Listen - Railway / Cloud Ready
const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server is running smoothly on port ${PORT}`);
});