const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. 中间件配置
app.use(cors());
app.use(bodyParser.json());
// 【关键】托管静态网页：让用户能访问 public 文件夹里的 HTML
app.use(express.static(path.join(__dirname, 'public')));

// 2. 数据库连接配置
const dbConfig = {
    host: process.env.DB_HOST || 'mysql6.sqlpub.com',
    port: parseInt(process.env.DB_PORT || 3311),
    user: process.env.DB_USER || 'gileg_root',
    password: process.env.DB_PASSWORD || 'vKK4UFJJv0aGFCFX',
    database: process.env.DB_NAME || 'gilegcn_mysql',
    connectTimeout: 20000,
    ssl: { rejectUnauthorized: false },
    multipleStatements: true
};

// 3. 后端 API 接口
app.post('/api/mysql', async (req, res) => {
    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);
        
        // 自动建表（确保表存在）
        await connection.query(`
            CREATE TABLE IF NOT EXISTS email_code_temp (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(100),
                code VARCHAR(10),
                create_time DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const { sql, params } = req.body;
        // console.log("执行SQL:", sql); 

        const [rows] = await connection.query(sql, params);
        res.status(200).json(rows);

    } catch (error) {
        console.error("数据库错误:", error);
        res.status(500).json({ error: error.message, code: error.code });
    } finally {
        if (connection) await connection.end();
    }
});

// 4. 启动服务
app.listen(PORT, () => {
    console.log(`服务已启动，端口: ${PORT}`);
});