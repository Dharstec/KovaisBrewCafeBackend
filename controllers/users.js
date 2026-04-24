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
        if (!existingUserData) {
            const password = bcrypt.hashSync(req.body.password, SALT_ROUNDS);
            const newUser = { ...req.body, password, created_at: new Date() };
            await POSTGRESQLService.PostgresInsert(TABLE_USERS, newUser);
            res.json({ status: 'success', message: 'Successfully Created' });
        } else {
            res.status(400).json({ status: 'error', message: `User already exists with Email: ${existingUserData.email}` });
        }
    } catch (error) {
        console.log(error)
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
                expiresIn: isAdmin ? '10d' : '10d'
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


module.exports = { login, createUser };
