const express = require("express");
const cors = require("cors");
const helmet = require('helmet');
const bodyParser = require('body-parser');

require("dotenv").config();

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(helmet());
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ limit: '5mb', extended: true }));

require("./baseroute")(app);


app.use((req, res, next) => {
    console.log('Client IP:', req.ip);
    res.setHeader('Content-Security-Policy', 'default-src *');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

app.use((err, req, res, next) => {
    if (err.status >= 400 && err.status < 500) {
        console.error(err.message, { stack: err.stack });
    } else if (err.status >= 500) {
        console.error(err.message, { stack: err.stack });
    }
    res.status(err.status || 500).send(err.message || 'Internal Server Error');
});

app.listen(process.env.PORT, () => {
    console.log(`Server is running on port ${process.env.PORT}`);
});
