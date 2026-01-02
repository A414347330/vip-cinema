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

    // 2. 这里的配置和你本地Navicat能连上的一模一样
    const dbConfig = {
        host: 'mysql6.sqlpub.com',
        port: 3311,
        user: 'gileg_root',
        password: 'vKK4UFJJv0aGFCFX',
        database: 'gilegcn_mysql',
        connectTimeout: 20000, // 增加到20秒超时
        ssl: {
            rejectUnauthorized: false // 允许自签名证书
        }
    };

    let connection;
    try {
        console.log("正在尝试从 Vercel 连接到 sqlpub...");
        
        // 3. 建立连接
        connection = await mysql.createConnection(dbConfig);
        console.log("✅ 连接成功！");

        // 4. 自动建表（确保表存在）
        await connection.query(`
            CREATE TABLE IF NOT EXISTS email_code_temp (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(100),
                code VARCHAR(10),
                create_time DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 5. 执行查询
        const { sql, params } = req.body;
        const [rows] = await connection.execute(sql, params);
        res.status(200).json(rows);

    } catch (error) {
        console.error("❌ 连接失败:", error);
        
        // 【关键】把具体的错误信息返回给前端，而不是笼统的“连接失败”
        // 这样我们就能在浏览器里看到到底是密码错(ACCESS_DENIED)还是被墙了(ETIMEDOUT)
        res.status(500).json({ 
            error: "DB_CONNECTION_FAILED", 
            message: error.message,
            code: error.code, // 错误代码，如 ETIMEDOUT, ECONNREFUSED
            syscall: error.syscall,
            hostname: dbConfig.host
        });
    } finally {
        if (connection) await connection.end();
    }
}
