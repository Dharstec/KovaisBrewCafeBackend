const POSTGRESQLService = require('../helpers/POSTGRES');
const { generateSearchString } = require("../helpers")

const TABLE_SPENT = process.env.TABLE_SPENT || 'spent';

const getAllRecords = async (req, res) => {
    try {
        const shopId = req.shop_id;
        const page     = parseInt(req.query.page,     10) || 1;
        const pageSize = parseInt(req.query.pageSize, 10) || 10;
        const offset   = (page - 1) * pageSize;

        const sortColumn = req.query.sortColumn || 'date';
        const sortOrder  = (req.query.sortOrder || 'DESC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

        const searchTerm      = req.query.searchTerm?.trim() || '';
        const searchConditions = searchTerm
            ? generateSearchString(searchTerm, ['reason', 'amount'])
            : '';

        const todayStr = new Date().toISOString().slice(0, 10);
        const dateRx   = /^\d{4}-\d{2}-\d{2}$/;
        const startDate = (req.query.startDate && dateRx.test(req.query.startDate))
            ? req.query.startDate : todayStr;
        const endDate   = (req.query.endDate   && dateRx.test(req.query.endDate))
            ? req.query.endDate   : todayStr;

        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        const monthTotal   = await POSTGRESQLService.PostgresAny(
            `SELECT COALESCE(SUM(amount),0) AS total_spent_this_month FROM ${TABLE_SPENT} WHERE date >= $1 AND date <= $2 AND shop_id = $3`,
            [startOfMonth, endOfMonth, shopId]
        );

        const rangeTotal = await POSTGRESQLService.PostgresAny(
            `SELECT COALESCE(SUM(amount),0) AS range_total FROM ${TABLE_SPENT} WHERE date::date BETWEEN $1::date AND $2::date AND shop_id = $3`,
            [startDate, endDate, shopId]
        );

        const query = `
            SELECT
                s.id, s.reason, s.amount, s.date, s.payment_mode,
                s.created_at, s.updated_at,
                TO_CHAR(s.date, 'DD-MM-YYYY')           AS spent_date,
                COALESCE(SUM(sp.amount), 0)             AS total_paid,
                s.amount - COALESCE(SUM(sp.amount), 0)  AS amount_due,
                COUNT(sp.id)                            AS payment_count,
                COUNT(*) OVER()                         AS total_count
            FROM ${TABLE_SPENT} s
            LEFT JOIN spent_payments sp ON sp.spent_id = s.id
            WHERE s.date::date BETWEEN $1::date AND $2::date
              AND s.shop_id = $5
            ${searchConditions ? searchConditions.replace(/reason/g, 's.reason').replace(/amount/g, 's.amount') : ''}
            GROUP BY s.id
            ORDER BY s.${sortColumn} ${sortOrder}
            LIMIT $3 OFFSET $4
        `;
        const data = await POSTGRESQLService.PostgresAny(query, [startDate, endDate, pageSize, offset, shopId]);

        res.json({
            status: 'success',
            data,
            total_spent_this_month: monthTotal[0]?.total_spent_this_month || 0,
            range_total: rangeTotal[0]?.range_total || 0,
            total_count: data.length > 0 ? parseInt(data[0].total_count, 10) : 0
        });
    } catch (err) {
        console.error('getAllRecords error:', err);
        res.status(500).json({ status: 'error', message: 'Internal Server Error' });
    }
};

const addRecord = async (req, res) => {
    try {
        const row = await POSTGRESQLService.PostgresInsert(TABLE_SPENT, { ...req.body, shop_id: req.shop_id });
        res.json({ status: 'success', message: 'Item added', id: row.id });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
};

const updateRecord = async (req, res) => {
    try {
        const updatedItem = { ...req.body, updated_at: new Date().toISOString() };
        delete updatedItem.shop_id;
        await POSTGRESQLService.PostgresUpdate(TABLE_SPENT, updatedItem, { id: req.params.id, shop_id: req.shop_id });
        res.json({ status: 'success', message: 'Updated' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
};

const getUniqueReasons = async (req, res) => {
    try {
        const data = await POSTGRESQLService.PostgresAny(
            `SELECT DISTINCT reason FROM ${TABLE_SPENT}
             WHERE reason IS NOT NULL AND reason <> '' AND shop_id = $1
             ORDER BY reason ASC`,
            [req.shop_id]
        );
        res.json(data.map((r) => r.reason));
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
};

const deleteRecord = async (req, res) => {
    try {
        await POSTGRESQLService.PostgresAny(
            `DELETE FROM ${TABLE_SPENT} WHERE id = $1 AND shop_id = $2`,
            [req.params.id, req.shop_id]
        );
        res.json({ status: 'success', message: 'Item removed' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
};

const getPayments = async (req, res) => {
    try {
        const data = await POSTGRESQLService.PostgresAny(
            `SELECT sp.id, sp.spent_id, TO_CHAR(sp.payment_date,'DD-MM-YYYY') AS payment_date_fmt,
                    sp.payment_date, sp.amount, sp.payment_mode, sp.note, sp.created_at
             FROM spent_payments sp
             JOIN ${TABLE_SPENT} s ON s.id = sp.spent_id
             WHERE sp.spent_id = $1 AND s.shop_id = $2
             ORDER BY sp.payment_date ASC, sp.created_at ASC`,
            [req.params.id, req.shop_id]
        );
        res.json(data);
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
};

const addPayment = async (req, res) => {
    try {
        const { payment_date, amount, payment_mode = 'CASH', note } = req.body;
        const shopId = req.shop_id;
        if (!payment_date || !amount) {
            return res.status(400).json({ status: 'error', message: 'payment_date and amount required' });
        }

        const spend = await POSTGRESQLService.PostgresAny(
            `SELECT amount,
                    COALESCE((SELECT SUM(amount) FROM spent_payments WHERE spent_id = $1), 0) AS already_paid
             FROM spent WHERE id = $1 AND shop_id = $2`,
            [req.params.id, shopId]
        );
        if (!spend.length) return res.status(404).json({ status: 'error', message: 'Spend not found' });

        const remaining = Number(spend[0].amount) - Number(spend[0].already_paid);
        if (Number(amount) > remaining + 0.01) {
            return res.status(400).json({
                status: 'error',
                message: `Payment ₹${amount} exceeds remaining due ₹${remaining.toFixed(2)}`
            });
        }

        const result = await POSTGRESQLService.PostgresInsert('spent_payments', {
            spent_id:     Number(req.params.id),
            payment_date,
            amount:       Number(amount),
            payment_mode,
            note:         note || null,
            shop_id:      shopId
        });
        res.json({ status: 'success', payment: result });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
};

const deletePayment = async (req, res) => {
    try {
        await POSTGRESQLService.PostgresAny(
            `DELETE FROM spent_payments WHERE id = $1 AND shop_id = $2`,
            [req.params.payment_id, req.shop_id]
        );
        res.json({ status: 'success', message: 'Payment removed' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
};

module.exports = {
    getAllRecords,
    addRecord,
    updateRecord,
    deleteRecord,
    getUniqueReasons,
    getPayments,
    addPayment,
    deletePayment
};
