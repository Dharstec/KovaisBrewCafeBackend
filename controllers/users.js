const POSTGRESQLService = require('../helpers/POSTGRES');
const { columns } = require("../helpers/PGPCOLUMNS");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { generateOtpEmailTemplate } = require('../helpers/nodemailer/emailTemplates/generateOtpEmailTemplate');
const { sendBulkEmails } = require("../helpers/nodemailer")


const TABLE_USERS = process.env.TABLE_USERS;
const TABLE_ROLES = process.env.TABLE_ROLES;
const SALT_ROUNDS = parseInt(process.env.SALT_ROUNDS, 10);
const SECRET_CODE = process.env.SECRET_CODE;

if (!TABLE_USERS || !TABLE_ROLES || !SALT_ROUNDS || !SECRET_CODE) {
    throw new Error("Required environment variables are not set.");
}


const createUser = async (req, res) => {
    try {
        const email = req.body.email;
        const existingUserData = await getUserByUserId(email);
        if (existingUserData) {
            return res.status(400).json({ status: 'error', message: `User already exists with Email: ${existingUserData.email}` });
        }

        const password = bcrypt.hashSync(req.body.password, SALT_ROUNDS);
        const body = { ...req.body, password, created_at: new Date() };

        const roleId = Number(body.role_id);
        const role = await POSTGRESQLService.PostgresAny(
            `SELECT role_type FROM ${TABLE_ROLES} WHERE id = $1`, [roleId]
        );
        const isAdminRole = role[0]?.role_type === 'Admin';

        if (isAdminRole) {
            body.shop_id = null;
        } else {
            const requestedShop = body.shop_id != null ? Number(body.shop_id) : null;
            body.shop_id = requestedShop || req.shop_id || 1;
        }

        await POSTGRESQLService.PostgresInsert(TABLE_USERS, body);
        res.json({ status: 'success', message: 'Successfully Created' });
    } catch (error) {
        console.log(error);
        handleServerError(res, error);
    }
};

const getShops = async (_req, res) => {
    try {
        const shops = await POSTGRESQLService.PostgresAny(
            `SELECT id, name, code, is_active FROM shops WHERE is_active = true ORDER BY id`
        );
        res.json({ status: 'success', data: shops });
    } catch (error) {
        handleServerError(res, error);
    }
};

const handleServerError = (res, error) => {
    console.error('Error:', error);
    res.status(500).json({ status: 'error', message: 'Internal Server Error' });
};

const getUserByUserId = async (email) => {
    const query = `SELECT ${columns.toString()} FROM ${TABLE_USERS} u INNER JOIN ${TABLE_ROLES} r ON u.role_id = r.id WHERE email = $1`;
    const data = await POSTGRESQLService.PostgresAny(query, [email]);
    return data.length > 0 ? data[0] : null;
};

const login = async (req, res) => {
    try {
        const { email, password, otp } = req.body;
        const existingUser = await getUserByUserId(email);

        if (!existingUser) {
            return res.status(404).json({ status: 'error', message: `Email Id not found with: ${email}` });
        }

        if (existingUser.role_type === 'Admin') {
            if (!otp) {
                const generatedOtp = Math.floor(100000 + Math.random() * 900000);
                await saveOtpToDB(existingUser.id, generatedOtp);
                const html = generateOtpEmailTemplate(generatedOtp, email);
                await sendBulkEmails({
                    recipients: [email],
                    subject: "Your OTP for Kovai's Brew Cafe Admin Login",
                    html
                });
                return res.status(200).json({
                    status: 'otp-required',
                    message: 'OTP sent to email',
                    user_id: existingUser.id
                });

            } else {
                const isValidOtp = await verifyOtpFromUser(existingUser.id, otp);
                if (!isValidOtp) {
                    return res.status(401).json({ status: 'error', message: "Invalid OTP" });
                }

                await POSTGRESQLService.PostgresAny(
                    `UPDATE ${TABLE_USERS} SET otp_code = NULL, expires_at = NULL WHERE id = $1`,
                    [existingUser.id]
                );
            }
        } else {
            const passwordIsValid = bcrypt.compareSync(password, existingUser.password);
            if (!passwordIsValid) {
                return res.status(401).json({ status: 'error', message: "Invalid Password!" });
            }
        }

        const isAdmin = existingUser.role_type === 'Admin';

        const token = jwt.sign(
            {
                user_name: existingUser.user_name,
                email: existingUser.email,
                user_id: existingUser.id,
                role_type: existingUser.role_type,
                shop_id: existingUser.shop_id ?? null,
            },
            SECRET_CODE,
            {
                expiresIn: '365d'
            }
        );

        delete existingUser.password;

        return res.status(200).json({
            status: 'success',
            data: {
                user_data: existingUser,
                accessToken: token
            }
        });

    } catch (error) {
        handleServerError(res, error);
    }
};


const saveOtpToDB = async (user_id, otp_code) => {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const query = `UPDATE ${TABLE_USERS} set otp_code = $1,expires_at = $2 WHERE id = $3`;
    const data = await POSTGRESQLService.PostgresAny(query, [otp_code, expiresAt, user_id]);
    return data;
};

const verifyOtpFromUser = async (user_id, otp_code) => {
    const query = `SELECT id FROM users WHERE id = $1 AND otp_code = $2 AND expires_at AT TIME ZONE 'UTC' > NOW()`;
    const result = await POSTGRESQLService.PostgresAny(query, [user_id, otp_code]);
    return result.length > 0;
};


const getUsers = async (req, res) => {
    try {
        const users = await POSTGRESQLService.PostgresAny(`
            SELECT u.id, u.user_name, u.email, u.shop_id, u.role_id,
                   r.role_type, s.name AS shop_name, u.created_at
            FROM ${TABLE_USERS} u
            JOIN ${TABLE_ROLES} r ON r.id = u.role_id
            LEFT JOIN shops s ON s.id = u.shop_id
            ORDER BY u.created_at DESC
        `);
        res.json({ status: 'success', data: users });
    } catch (error) {
        handleServerError(res, error);
    }
};

const updateUser = async (req, res) => {
    try {
        const id = Number(req.params.id);
        const { user_name, role_id, shop_id, password } = req.body;

        const fields = [];
        const params = [];

        if (user_name !== undefined && user_name.trim()) {
            params.push(user_name.trim());
            fields.push(`user_name = $${params.length}`);
        }

        if (role_id !== undefined) {
            const role = await POSTGRESQLService.PostgresAny(
                `SELECT role_type FROM ${TABLE_ROLES} WHERE id = $1`, [role_id]
            );
            const isAdminRole = role[0]?.role_type === 'Admin';
            params.push(Number(role_id));
            fields.push(`role_id = $${params.length}`);
            const resolvedShop = isAdminRole ? null : (shop_id != null ? Number(shop_id) : 1);
            params.push(resolvedShop);
            fields.push(`shop_id = $${params.length}`);
        } else if (shop_id !== undefined) {
            params.push(shop_id != null ? Number(shop_id) : null);
            fields.push(`shop_id = $${params.length}`);
        }

        if (password && password.trim()) {
            params.push(bcrypt.hashSync(password.trim(), SALT_ROUNDS));
            fields.push(`password = $${params.length}`);
        }

        if (!fields.length) {
            return res.status(400).json({ message: 'Nothing to update' });
        }

        params.push(id);
        const result = await POSTGRESQLService.PostgresAny(
            `UPDATE ${TABLE_USERS} SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING id`,
            params
        );
        if (!result.length) return res.status(404).json({ message: 'User not found' });

        res.json({ status: 'success', message: 'User updated' });
    } catch (error) {
        handleServerError(res, error);
    }
};

const deleteUser = async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (id === req.user_id) {
            return res.status(400).json({ message: 'Cannot delete your own account' });
        }
        await POSTGRESQLService.PostgresAny(
            `DELETE FROM ${TABLE_USERS} WHERE id = $1`, [id]
        );
        res.json({ status: 'success', message: 'User deleted' });
    } catch (error) {
        handleServerError(res, error);
    }
};

const getRoles = async (req, res) => {
    try {
        const roles = await POSTGRESQLService.PostgresAny(
            `SELECT id, role_type, created_at FROM ${TABLE_ROLES} ORDER BY id`
        );
        res.json({ status: 'success', data: roles });
    } catch (error) {
        handleServerError(res, error);
    }
};

const createRole = async (req, res) => {
    try {
        const { role_type } = req.body;
        if (!role_type?.trim()) {
            return res.status(400).json({ message: 'Role name is required' });
        }
        const existing = await POSTGRESQLService.PostgresAny(
            `SELECT id FROM ${TABLE_ROLES} WHERE role_type ILIKE $1`, [role_type.trim()]
        );
        if (existing.length) {
            return res.status(400).json({ message: 'A role with this name already exists' });
        }
        // Copy Admin's permission structure as the base
        const base = await POSTGRESQLService.PostgresAny(
            `SELECT role_behaviour, menu FROM ${TABLE_ROLES} WHERE role_type = 'Admin' LIMIT 1`
        );
        const result = await POSTGRESQLService.PostgresAny(
            `INSERT INTO ${TABLE_ROLES} (role_type, role_behaviour, menu, created_at)
             VALUES ($1, $2, $3, NOW()) RETURNING id, role_type`,
            [role_type.trim(), base[0]?.role_behaviour || {}, base[0]?.menu || {}]
        );
        res.status(201).json({ status: 'success', data: result[0] });
    } catch (error) {
        handleServerError(res, error);
    }
};

module.exports = { login, createUser, getShops, getUsers, updateUser, deleteUser, getRoles, createRole };
