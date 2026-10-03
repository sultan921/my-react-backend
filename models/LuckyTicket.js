const mongoose = require("mongoose");

const luckyTicketSchema = new mongoose.Schema(
  {
    publicCode: {
      type: String,
      required: true,
      unique: true,
      index: true
    },

    secretCode: {
      type: String,
      required: true,
      unique: true
    },

    userId: {
      type: String,
      required: true
    },

    userName: {
      type: String,
      required: true
    },

    phone: {
      type: String,
      required: true
    },

    roundId: {
      type: String,
      required: true,
      index: true
    },

    paymentMethod: {
      type: String,
      enum: ["coins", "easypaisa", "jazzcash"],
      required: true
    },

    status: {
      type: String,
      enum: ["active", "expired", "winner", "cancelled"],
      default: "active"
    },

    issuedAt: {
      type: Date,
      default: Date.now
    },

    expiresAt: {
      type: Date,
      required: true
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("LuckyTicket", luckyTicketSchema);