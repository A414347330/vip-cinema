// api/mysql.js
const mysql = require('mysql2/promise'); // 使用 Promise 版本更适合 Serverless

export default async function handler(req, res) {
    // 1. 设置跨域允许 (重要！否则网页无法访问)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    // 处理 OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // 2. 连接数据库
    // 注意：这里使用了环境变量 (process.env)，保护你的密码不被泄露到 GitHub
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    try {
        const { sql, params } = req.body;
        console.log('执行SQL:', sql);

        // 3. 执行查询
        const [rows] = await connection.execute(sql, params);
        
        // 4. 返回结果
        res.status(200).json(rows);
    } catch (error) {
        console.error('数据库错误:', error);
        res.status(500).json({ error: error.message });
    } finally {
        // 5. 关闭连接 (Serverless 必须用完即关)
        await connection.end();
    }
}