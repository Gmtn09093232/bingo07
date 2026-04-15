// models/User.js
import { Schema, model } from "../db";

const userSchema = new Schema({
    username: String,
    password: String,
    balance: { type: Number, default: 100 }
});

export default model("User", userSchema);