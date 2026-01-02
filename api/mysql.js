// api/mysql.js
const mysql = require('mysql2/promise');

export default async function handler(req, res) {
    // 1. 设置跨域
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // 2. 数据库配置
    const dbConfig = {
        host: 'mysql6.sqlpub.com',
        port: 3311,
        user: 'gileg_root',
        password: 'vKK4UFJJv0aGFCFX',
        database: 'gilegcn_mysql',
        connectTimeout: 20000,
        ssl: { rejectUnauthorized: false },
        
        // 【核心修复点 1】允许一次执行多条 SQL (解决 ER_PARSE_ERROR)
        multipleStatements: true 
    };

    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);
        
        // 3. 自动建表（确保表存在）
        await connection.query(`
            CREATE TABLE IF NOT EXISTS email_code_temp (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(100),
                code VARCHAR(10),
                create_time DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const { sql, params } = req.body;
        console.log("执行SQL:", sql);

        // 【核心修复点 2】使用 .query() 而不是 .execute()
        // .execute() 不支持多条语句，改用 .query() 就好了
        const [rows] = await connection.query(sql, params);
        
        res.status(200).json(rows);

    } catch (error) {
        console.error("❌ SQL执行错误:", error);
        res.status(500).json({ 
            error: "SQL_ERROR", 
            message: error.message,
            code: error.code
        });
    } finally {
        if (connection) await connection.end();
    }
}
