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
    process.exit(1);
  });

// ==========================
// User Schema & Model
// ==========================
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  coins: { type: Number, default: 0 }
});

const User = mongoose.model("User", userSchema);

// ==========================
// API Routes (Auth)
// ==========================

// 1. Signup Route
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, phone, password } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ phone });
    if (existingUser) {
      return res.status(400).json({ error: "Yeh phone number pehle se registered hai!" });
    }

    // Create new user
    const newUser = new User({ name, phone, password, coins: 50 }); // Shuru mein 50 coins free de sakte hain
    await newUser.save();

    res.status(201).json({
      success: true,
      message: "Account successfully create ho gaya!",
      user: {
        id: newUser._id,
        name: newUser.name,
        phone: newUser.phone,
        coins: newUser.coins
      }
    });
  } catch (err) {
    res.status(500).json({ error: "Server error: " + err.message });
  }
});

// 2. Login Route
app.post("/api/auth/login", async (req, res) => {
  try {
    const { phone, password } = req.body;

    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(404).json({ error: "Yeh phone number register nahi hai!" });
    }

    if (user.password !== password) {
      return res.status(400).json({ error: "Ghalat Password!" });
    }

    res.status(200).json({
      success: true,
      message: "Login successful!",
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        coins: user.coins
      }
    });
  } catch (err) {
    res.status(500).json({ error: "Server error: " + err.message });
  }
});

// Root Route
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "🚀 Zeelop Backend is running successfully!",
  });
});

// ==========================
// Server Initialization
// ==========================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server is running smoothly on port ${PORT}`);
});