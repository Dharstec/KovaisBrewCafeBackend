const DB = require("../middleware/dbFunctions");

/* =========================================================
   CAFE SETTINGS  — global key-value config
   Currently used for: zomato_packing_default, swiggy_packing_default
   ========================================================= */

exports.getSettings = async (_req, res) => {
  try {
    const rows = await DB.PostgresAny(`SELECT key, value FROM cafe_settings`, []);
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json(settings);
  } catch (err) {
    console.error("Get settings error:", err);
    res.status(500).json({ msg: "Server error" });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    if (req.role_type !== 'Admin') {
      return res.status(403).json({ msg: "Admin access required" });
    }
    const allowed = ['zomato_packing_default', 'swiggy_packing_default'];
    const updates = [];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        const val = String(Number(req.body[key]) || 0);
        await DB.PostgresAny(
          `INSERT INTO cafe_settings (key, value, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
          [key, val]
        );
        updates.push(key);
      }
    }

    if (!updates.length) return res.status(400).json({ msg: "No valid settings provided" });
    res.json({ success: true, updated: updates });

  } catch (err) {
    console.error("Update settings error:", err);
    res.status(500).json({ msg: "Update failed" });
  }
};
