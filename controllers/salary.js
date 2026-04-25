const DB = require("../middleware/dbFunctions");

/* ─────────────────────────────────────────────────────────────
   HELPER: days in a month
───────────────────────────────────────────────────────────── */
function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/* ─────────────────────────────────────────────────────────────
   PREVIEW  GET /salary/preview?month=YYYY-MM
   Calculates salary from attendance + advances. Not saved.
───────────────────────────────────────────────────────────── */
exports.previewSalary = async (req, res) => {
  try {
    const { month } = req.query;
    if (!month) return res.status(400).json({ message: "month required (YYYY-MM)" });

    const [y, m] = month.split('-').map(Number);
    const start   = `${month}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const end     = `${month}-${String(lastDay).padStart(2, '0')}`;
    const totalDays = lastDay;

    const shopId = req.shop_id;
    const employees = await DB.PostgresAny(
      `SELECT id, name, salary_amount FROM employees WHERE is_active = true AND shop_id = $1 ORDER BY name`,
      [shopId]
    );

    const attRows = await DB.PostgresAny(
      `SELECT employee_id, status, COUNT(*) AS cnt
       FROM attendance
       WHERE date BETWEEN $1 AND $2 AND shop_id = $3
       GROUP BY employee_id, status`,
      [start, end, shopId]
    );

    const advRows = await DB.PostgresAny(
      `SELECT employee_id, COALESCE(SUM(amount::numeric), 0) AS total_advance
       FROM employee_advance
       WHERE TO_CHAR(advance_date, 'YYYY-MM') = $1 AND shop_id = $2
       GROUP BY employee_id`,
      [month, shopId]
    );

    const finalRows = await DB.PostgresAny(
      `SELECT employee_id, finalized, net_payable, advance_deduction
       FROM salary_records WHERE month = $1 AND shop_id = $2`,
      [month, shopId]
    );

    // Build lookup maps
    const attMap = {};
    for (const r of attRows) {
      if (!attMap[r.employee_id]) attMap[r.employee_id] = { P: 0, A: 0, H: 0, L: 0, HL: 0, WO: 0 };
      attMap[r.employee_id][r.status] = parseInt(r.cnt, 10);
    }

    const advMap = {};
    for (const r of advRows) advMap[r.employee_id] = Number(r.total_advance) || 0;

    const finalMap = {};
    for (const r of finalRows) finalMap[r.employee_id] = r;

    // 5. Calculate per employee
    const result = employees.map(emp => {
      const att   = attMap[emp.id] || { P: 0, A: 0, H: 0, L: 0, HL: 0, WO: 0 };
      const base  = parseFloat(emp.salary_amount) || 0;
      const adv   = advMap[emp.id] || 0;
      const final = finalMap[emp.id] || null;

      // Working days = calendar days − Weekly Off − Holidays (both are paid rest days)
      const weeklyOffDays  = att.WO;
      const holidayDays    = att.HL;
      const workingDays    = totalDays - weeklyOffDays - holidayDays;

      // Daily rate based on actual working days (not calendar days)
      const dailyRate      = workingDays > 0 ? base / workingDays : 0;

      const presentDays    = att.P + att.L + (att.H * 0.5); // late = full, half = 0.5
      const absentDays     = att.A;
      const halfDays       = att.H;
      const lateDays       = att.L;

      const absentDeduction  = parseFloat((absentDays * dailyRate).toFixed(2));
      const halfDeduction    = parseFloat((halfDays * (dailyRate * 0.5)).toFixed(2));
      const advanceDeduction = parseFloat(adv.toFixed(2));
      const netPayable       = parseFloat(
        Math.max(0, base - absentDeduction - halfDeduction - advanceDeduction).toFixed(2)
      );

      return {
        employee_id:       emp.id,
        employee_name:     emp.name,
        base_salary:       base,
        total_days:        totalDays,
        working_days:      workingDays,
        weekly_off_days:   weeklyOffDays,
        daily_rate:        parseFloat(dailyRate.toFixed(2)),
        present_days:      presentDays,
        absent_days:       absentDays,
        half_days:         halfDays,
        late_days:         lateDays,
        holiday_days:      holidayDays,
        absent_deduction:  absentDeduction,
        half_deduction:    halfDeduction,
        advance_deduction: advanceDeduction,
        net_payable:       netPayable,
        finalized:         final ? final.finalized : false
      };
    });

    res.json({ month, employees: result });
  } catch (err) {
    console.error('previewSalary:', err.message);
    res.status(500).json({ message: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────
   FINALIZE  POST /salary/finalize
   Body: { month, employees: [{ employee_id, advance_deduction }] }
   Saves / updates salary records and locks them.
───────────────────────────────────────────────────────────── */
exports.finalizeSalary = async (req, res) => {
  const { month, employees } = req.body;
  if (!month || !Array.isArray(employees) || !employees.length)
    return res.status(400).json({ message: "month and employees required" });

  const [y, m]  = month.split('-').map(Number);
  const start   = `${month}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end     = `${month}-${String(lastDay).padStart(2, '0')}`;
  const totalDays = lastDay;

  const shopId = req.shop_id;
  const client = await DB.getClient();
  try {
    await client.query("BEGIN");

    const attRows = await client.query(
      `SELECT employee_id, status, COUNT(*) AS cnt
       FROM attendance WHERE date BETWEEN $1 AND $2 AND shop_id = $3
       GROUP BY employee_id, status`,
      [start, end, shopId]
    );

    const attMap = {};
    for (const r of attRows.rows) {
      if (!attMap[r.employee_id]) attMap[r.employee_id] = { P: 0, A: 0, H: 0, L: 0, HL: 0, WO: 0 };
      attMap[r.employee_id][r.status] = parseInt(r.cnt, 10);
    }

    for (const e of employees) {
      const empRow = await client.query(
        `SELECT salary_amount FROM employees WHERE id = $1 AND shop_id = $2`,
        [e.employee_id, shopId]
      );
      if (!empRow.rows.length) continue;

      const base  = parseFloat(empRow.rows[0].salary_amount) || 0;
      const att   = attMap[e.employee_id] || { P: 0, A: 0, H: 0, L: 0, HL: 0, WO: 0 };
      const adv   = parseFloat(e.advance_deduction) || 0;

      // Working days = calendar days − WO − HL
      const weeklyOffDays  = att.WO;
      const holidayDays    = att.HL;
      const workingDays    = totalDays - weeklyOffDays - holidayDays;
      const dailyRate      = workingDays > 0 ? base / workingDays : 0;

      const presentDays     = att.P + att.L + (att.H * 0.5);
      const absentDays      = att.A;
      const halfDays        = att.H;
      const lateDays        = att.L;
      const absentDeduction = parseFloat((absentDays * dailyRate).toFixed(2));
      const halfDeduction   = parseFloat((halfDays * (dailyRate * 0.5)).toFixed(2));
      const netPayable      = parseFloat(
        Math.max(0, base - absentDeduction - halfDeduction - adv).toFixed(2)
      );

      await client.query(
        `INSERT INTO salary_records
           (employee_id, month, base_salary, total_days, present_days, absent_days,
            half_days, late_days, holiday_days, daily_rate,
            absent_deduction, half_deduction, advance_deduction, net_payable,
            finalized, finalized_at, shop_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,NOW(),$15)
         ON CONFLICT (employee_id, month) DO UPDATE SET
           base_salary       = EXCLUDED.base_salary,
           total_days        = EXCLUDED.total_days,
           present_days      = EXCLUDED.present_days,
           absent_days       = EXCLUDED.absent_days,
           half_days         = EXCLUDED.half_days,
           late_days         = EXCLUDED.late_days,
           holiday_days      = EXCLUDED.holiday_days,
           daily_rate        = EXCLUDED.daily_rate,
           absent_deduction  = EXCLUDED.absent_deduction,
           half_deduction    = EXCLUDED.half_deduction,
           advance_deduction = EXCLUDED.advance_deduction,
           net_payable       = EXCLUDED.net_payable,
           finalized         = true,
           finalized_at      = NOW()`,
        [
          e.employee_id, month, base, totalDays, presentDays, absentDays,
          halfDays, lateDays, holidayDays, parseFloat(dailyRate.toFixed(2)),
          absentDeduction, halfDeduction, adv, netPayable, shopId
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ message: "Salary finalized successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error('finalizeSalary:', err.message);
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
};

/* ─────────────────────────────────────────────────────────────
   HISTORY  GET /salary/history?employee_id=X
   Returns all finalized salary records for one employee
───────────────────────────────────────────────────────────── */
exports.getSalaryHistory = async (req, res) => {
  try {
    const { employee_id } = req.query;
    let query = `
      SELECT sr.*, e.name AS employee_name
      FROM salary_records sr
      JOIN employees e ON e.id = sr.employee_id
      WHERE sr.finalized = true AND sr.shop_id = $1`;
    const params = [req.shop_id];
    if (employee_id) {
      query += ` AND sr.employee_id = $2`;
      params.push(employee_id);
    }
    query += ` ORDER BY sr.month DESC, e.name`;

    const rows = await DB.PostgresAny(query, params);
    res.json(rows);
  } catch (err) {
    console.error('getSalaryHistory:', err.message);
    res.status(500).json({ message: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────
   ALL MONTHS  GET /salary/months
   Returns distinct finalized months for the history dropdown
───────────────────────────────────────────────────────────── */
exports.getSalaryMonths = async (req, res) => {
  try {
    const rows = await DB.PostgresAny(
      `SELECT DISTINCT month FROM salary_records WHERE finalized = true AND shop_id = $1 ORDER BY month DESC`,
      [req.shop_id]
    );
    res.json(rows.map(r => r.month));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
