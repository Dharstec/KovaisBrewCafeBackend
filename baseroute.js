const indexRoute = require("./routes/index");
const users = require("./routes/users");
const products = require("./routes/product");
const bills = require("./routes/billing");
const employees = require("./routes/employee");
const attendance = require("./routes/attendance");
const category = require("./routes/category");
const dashboard = require("./routes/dashboard");
const employeeAdvance = require("./routes/employeeAdvance");
const stock = require("./routes/stock");
const coupons = require("./routes/coupon");
const spend = require("./routes/spend");
const targets   = require("./routes/targets");
const stockItem = require("./routes/stockItem");
const salary    = require("./routes/salary");
const settings  = require("./routes/settings");
const stockCount    = require("./routes/stockCount");
const productAddon  = require("./routes/productAddon");

module.exports = function (app) {
    app.use("/", indexRoute);
    app.use("/api", users);
    app.use("/api", products);
    app.use("/api", bills);
    app.use("/api", category);
    app.use("/api", attendance);
    app.use("/api", dashboard);
    app.use("/api", employees);
    app.use("/api", employeeAdvance);
    app.use("/api", stock);
    app.use("/api", coupons);
    app.use("/api", spend);
    app.use("/api", targets);
    app.use("/api", stockItem);
    app.use("/api", salary);
    app.use("/api", settings);
    app.use("/api", stockCount);
    app.use("/api", productAddon);
}



