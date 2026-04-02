const DB = require("../middleware/dbFunctions");

/* ─────────────────────────────────────────────
   MARK ATTENDANCE (single day, batch upsert)
───────────────────────────────────────────── */
exports.markAttendance = async (req, res) => {
  const rows = req.body;
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ message: "Invalid data" });

  const client = await DB.getClient();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      if (!['P', 'A', 'O'].includes(r.status))
        throw new Error("Invalid attendance status");

      await client.query(
        `INSERT INTO attendance (employee_id, date, status, check_in, check_out)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (employee_id, date)
         DO UPDATE SET
           status    = EXCLUDED.status,
           check_in  = EXCLUDED.check_in,
           check_out = EXCLUDED.check_out`,
        [r.employee_id, r.date, r.status, r.check_in || null, r.check_out || null]
      );
    }
    await client.query("COMMIT");
    res.json({ message: "Attendance saved successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

/* ─────────────────────────────────────────────
   GET ATTENDANCE BY DATE (single day)
───────────────────────────────────────────── */
exports.getAttendanceByDate = async (req, res) => {
  const { date } = req.query;
  const data = await DB.PostgresAny(
    `SELECT
       e.id   AS employee_id,
       e.name,
       COALESCE(a.status, 'A') AS status,
       TO_CHAR(a.check_in,  'HH24:MI') AS check_in,
       TO_CHAR(a.check_out, 'HH24:MI') AS check_out
     FROM employees e
     LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = $1
     WHERE e.is_active = true
     ORDER BY e.name`,
    [date]
  );
  res.json(data);
};

/* ─────────────────────────────────────────────
   GET ATTENDANCE HISTORY
   GET /attendance/history?employee_id=X&month=YYYY-MM
   Returns all days in the month for one employee
   (or all employees if no employee_id given)
───────────────────────────────────────────── */
exports.getAttendanceHistory = async (req, res) => {
  try {
    const { employee_id, month } = req.query;
    // month = "2026-04"  →  first and last day
    const start = month ? `${month}-01` : new Date().toISOString().slice(0, 7) + '-01';
    const end   = month
      ? new Date(new Date(start).getFullYear(), new Date(start).getMonth() + 1, 0)
          .toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    let query = `
      SELECT
        e.id   AS employee_id,
        e.name AS employee_name,
        a.date,
        a.status,
        TO_CHAR(a.check_in,  'HH24:MI') AS check_in,
        TO_CHAR(a.check_out, 'HH24:MI') AS check_out
      FROM employees e
      JOIN attendance a ON a.employee_id = e.id
      WHERE e.is_active = true
        AND a.date BETWEEN $1 AND $2`;

    const params = [start, end];

    if (employee_id) {
      query += ` AND e.id = $3`;
      params.push(employee_id);
    }

    query += ` ORDER BY e.name, a.date DESC`;

    const rows = await DB.PostgresAny(query, params);

    // Group by employee
    const grouped = {};
    for (const r of rows) {
      if (!grouped[r.employee_id]) {
        grouped[r.employee_id] = {
          employee_id:   r.employee_id,
          employee_name: r.employee_name,
          records:       []
        };
      }
      grouped[r.employee_id].records.push({
        date:      r.date,
        status:    r.status,
        check_in:  r.check_in,
        check_out: r.check_out
      });
    }

    // Attach summary counts
    const result = Object.values(grouped).map(emp => {
      const present = emp.records.filter(r => r.status === 'P').length;
      const absent  = emp.records.filter(r => r.status === 'A').length;
      const off     = emp.records.filter(r => r.status === 'O').length;
      return { ...emp, present_days: present, absent_days: absent, off_days: off };
    });

    res.json({ month: month || start.slice(0, 7), employees: result });
  } catch (err) {
    console.error('getAttendanceHistory:', err.message);
    res.status(500).json({ message: err.message });
  }
};
