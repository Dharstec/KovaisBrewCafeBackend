const express = require("express");
const router  = express.Router();
const c       = require("../controllers/settings");
const { verifyToken } = require("../middleware/auth.js");

router.get("/settings", verifyToken, c.getSettings);    // all users can read
router.put("/settings", verifyToken, c.updateSettings); // role check inside controller

module.exports = router;
