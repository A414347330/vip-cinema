// api/mysql.js
const mysql = require('mysql2/promise');

export default async function handler(req, res) {
    // 1. 设置跨域头，允许网页访问
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    // 处理预检请求
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    let connection;
    try {
        // 2. 配置数据库连接
        // 优先读取环境变量，如果没有读取到，则使用代码里的硬编码（为了确保你现在能跑通）
        const dbConfig = {
            host: process.env.DB_HOST || 'mysql6.sqlpub.com',
            port: parseInt(process.env.DB_PORT || 3311),
            user: process.env.DB_USER || 'gileg_root',
            password: process.env.DB_PASSWORD || 'vKK4UFJJv0aGFCFX',
            database: process.env.DB_NAME || 'gilegcn_mysql',
            // 【关键修改】MySQL 8.0 远程连接必须加这个 SSL 配置，否则经常连不上
            ssl: {
                rejectUnauthorized: false
            }
        };

        console.log("正在连接数据库...", dbConfig.host);
        connection = await mysql.createConnection(dbConfig);
        console.log("✅ 数据库连接成功！");

        // 3. 【自动修复】检查并创建缺失的 email_code_temp 表
        // 这段代码会自动帮你把缺失的表建立起来
        const createTableSQL = `
            CREATE TABLE IF NOT EXISTS email_code_temp (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(100) NOT NULL,
                code VARCHAR(10) NOT NULL,
                create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_email (email)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `;
        await connection.query(createTableSQL);

        // 4. 执行前端传来的 SQL
        const { sql, params } = req.body;
        console.log("执行SQL:", sql);

        const [rows] = await connection.execute(sql, params);
        
        // 返回结果
        res.status(200).json(rows);

    } catch (error) {
        console.error("❌ 发生错误:", error);
        res.status(500).json({ 
            error: "Database Error", 
            details: error.message, // 返回具体错误信息
            code: error.code 
        });
    } finally {
        if (connection) await connection.end();
    }
}
