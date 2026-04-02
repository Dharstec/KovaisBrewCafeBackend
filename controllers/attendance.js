const DB = require("../middleware/dbFunctions");

const VALID_STATUSES = ['P', 'A', 'H', 'L', 'HL'];
// P  = Present   | A  = Absent  | H  = Half Day
// L  = Late      | HL = Holiday

/* ─────────────────────────────────────────────
   MARK ATTENDANCE  (single day, batch upsert)
───────────────────────────────────────────── */
exports.markAttendance = async (req, res) => {
  const rows = req.body;
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ message: "Invalid data" });

  const client = await DB.getClient();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      if (!VALID_STATUSES.includes(r.status))
        throw new Error(`Invalid status '${r.status}'. Allowed: ${VALID_STATUSES.join(', ')}`);

      // Clear check_in/check_out for statuses that don't need them
      const hasTime = ['P', 'H', 'L'].includes(r.status);

      await client.query(
        `INSERT INTO attendance (employee_id, date, status, check_in, check_out)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (employee_id, date)
         DO UPDATE SET
           status    = EXCLUDED.status,
           check_in  = EXCLUDED.check_in,
           check_out = EXCLUDED.check_out`,
        [
          r.employee_id,
          r.date,
          r.status,
          hasTime ? (r.check_in  || null) : null,
          hasTime ? (r.check_out || null) : null
        ]
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
   GET ATTENDANCE BY DATE  (single day)
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
   GET ATTENDANCE HISTORY / REPORT
   Supports two modes:
     ?start=YYYY-MM-DD&end=YYYY-MM-DD  (date range)
     ?month=YYYY-MM                    (whole month, legacy)
   Optional: &employee_id=X  to filter one employee
───────────────────────────────────────────── */
exports.getAttendanceHistory = async (req, res) => {
  try {
    const { employee_id, month, start, end } = req.query;

    let startDate, endDate;
    if (start && end) {
      startDate = start;
      endDate   = end;
    } else {
      const m = month || new Date().toISOString().slice(0, 7);
      startDate = `${m}-01`;
      const sd  = new Date(startDate + 'T12:00:00');
      endDate   = new Date(sd.getFullYear(), sd.getMonth() + 1, 0)
                    .toISOString().slice(0, 10);
    }

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

    const params = [startDate, endDate];
    if (employee_id) {
      query += ` AND e.id = $3`;
      params.push(employee_id);
    }
    query += ` ORDER BY e.name, a.date`;

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

    // Per-employee counts & attendance %
    const result = Object.values(grouped).map(emp => {
      const counts = { P: 0, A: 0, H: 0, L: 0, HL: 0 };
      for (const r of emp.records) {
        if (counts.hasOwnProperty(r.status)) counts[r.status]++;
      }
      // Work days = all days except Holiday
      const workDays   = emp.records.filter(r => r.status !== 'HL').length;
      // Half-day counts as 0.5, Late still counts as 1
      const presentVal = counts.P + (counts.H * 0.5) + counts.L;
      const attendance_pct = workDays > 0 ? Math.round((presentVal / workDays) * 100) : 0;

      return { ...emp, counts, attendance_pct };
    });

    res.json({ start: startDate, end: endDate, employees: result });
  } catch (err) {
    console.error('getAttendanceHistory:', err.message);
    res.status(500).json({ message: err.message });
  }
};
