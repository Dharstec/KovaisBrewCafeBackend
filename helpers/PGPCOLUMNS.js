const columns = [
    "ROW_NUMBER() OVER(ORDER BY u.created_at ASC) AS sno",
    "u.id",
    "u.role_id",
    "u.user_name",
    "u.password",
    "u.email",
    "u.shop_id",
    "r.role_type",
    "r.role_behaviour",
    "r.menu",
    "COUNT(*) OVER() AS total_count"
];


module.exports = {
    columns
}
