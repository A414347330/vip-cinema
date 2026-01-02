// api/mysql.js
const mysql = require('mysql2/promise');

export default async function handler(req, res) {
    // 1. 设置跨域
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // 2. 打印调试日志 (在 Vercel Logs 里能看到)
    console.log("正在尝试连接数据库...");
    console.log("Host:", process.env.DB_HOST);
    console.log("User:", process.env.DB_USER);
    console.log("Port:", process.env.DB_PORT); 
    // 千万不要打印密码，打印密码不安全

    if (!process.env.DB_HOST) {
        console.error("❌ 错误：环境变量 DB_HOST 未读取到！请检查 Vercel 设置。");
        return res.status(500).json({ error: "环境变量未配置" });
    }

    let connection;
    try {
        // 3. 建立连接
        connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            port: parseInt(process.env.DB_PORT || 3306), // 强制转为数字
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            connectTimeout: 10000 // 10秒连接超时
        });

        console.log("✅ 数据库连接成功！");

        const { sql, params } = req.body;
        console.log("执行SQL:", sql);

        const [rows] = await connection.execute(sql, params);
        res.status(200).json(rows);

    } catch (error) {
        console.error("❌ 数据库报错详情:", error);
        // 将具体的错误信息返回给前端，方便你在网页 Toast 里看到
        res.status(500).json({ error: error.message, code: error.code });
    } finally {
        if (connection) await connection.end();
    }
}
