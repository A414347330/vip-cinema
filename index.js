const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// 数据库配置
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

// --- 初始化数据库结构 ---
async function initDB() {
    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);
        console.log("正在检查数据库结构...");

        // 1. 确保 email_code_temp 存在
        await connection.query(`
            CREATE TABLE IF NOT EXISTS email_code_temp (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(100),
                code VARCHAR(10),
                create_time DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 2. 创建激活码表 (activation_codes)
        await connection.query(`
            CREATE TABLE IF NOT EXISTS activation_codes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                code VARCHAR(50) UNIQUE NOT NULL,
                is_used TINYINT(1) DEFAULT 0,
                used_by VARCHAR(100) DEFAULT NULL,
                create_time DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 3. 升级 users 表 (增加 is_active 和 role 字段)
        // 注意：这里使用忽略错误的方式尝试添加列，防止重复添加报错
        try {
            await connection.query(`ALTER TABLE users ADD COLUMN is_active TINYINT(1) DEFAULT 0`);
            console.log("✅ 成功添加 is_active 字段");
        } catch (e) {}
        try {
            await connection.query(`ALTER TABLE users ADD COLUMN role VARCHAR(20) DEFAULT 'user'`);
            console.log("✅ 成功添加 role 字段");
        } catch (e) {}

    } catch (err) {
        console.error("初始化数据库失败:", err);
    } finally {
        if (connection) await connection.end();
    }
}
// 启动时运行初始化
initDB();

// --- 核心 API ---

// 1. 通用查询接口 (保留给注册用)
app.post('/api/mysql', async (req, res) => {
    /* ...保留原有注册逻辑，为了节省篇幅，此处直接复用你之前的逻辑即可，或者使用下面的通用处理... */
    const { sql, params } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const [rows] = await conn.query(sql, params);
        res.json(rows);
    } catch (e) { res.status(500).json({error: e.message}); } 
    finally { if(conn) conn.end(); }
});

// 2. 登录接口
app.post('/api/login', async (req, res) => {
    const { account, password } = req.body; // account 可以是手机或邮箱
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        // 查询用户
        const [users] = await conn.query(
            "SELECT * FROM users WHERE (username=? OR email=?) AND password_hash=?", 
            [account, account, password]
        );
        
        if (users.length > 0) {
            const user = users[0];
            // 返回用户信息（不包含密码）
            res.json({
                success: true,
                user: {
                    id: user.user_id || user.id,
                    username: user.username,
                    role: user.role,
                    is_active: user.is_active
                }
            });
        } else {
            res.status(401).json({ success: false, message: "账号或密码错误" });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        if (conn) conn.end();
    }
});

// 3. 激活账号接口
app.post('/api/activate', async (req, res) => {
    const { username, code } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        
        // 检查激活码是否存在且未使用
        const [codes] = await conn.query("SELECT * FROM activation_codes WHERE code=? AND is_used=0", [code]);
        
        if (codes.length > 0) {
            // 激活逻辑：1.标记码已用 2.更新用户状态
            await conn.query("UPDATE activation_codes SET is_used=1, used_by=? WHERE code=?", [username, code]);
            await conn.query("UPDATE users SET is_active=1 WHERE username=?", [username]);
            res.json({ success: true });
        } else {
            res.status(400).json({ success: false, message: "激活码无效或已被使用" });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        if (conn) conn.end();
    }
});

// 4. 管理员：生成激活码
app.post('/api/admin/generate', async (req, res) => {
    const { adminUser, count } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        // 简单权限校验
        const [admins] = await conn.query("SELECT role FROM users WHERE username=? AND role='admin'", [adminUser]);
        if (admins.length === 0) return res.status(403).json({message: "无权操作"});

        const newCodes = [];
        for(let i=0; i< (count || 1); i++) {
            // 生成随机码 VIP-XXXX-XXXX
            const code = 'VIP-' + Math.random().toString(36).substr(2, 4).toUpperCase() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
            await conn.query("INSERT INTO activation_codes (code) VALUES (?)", [code]);
            newCodes.push(code);
        }
        res.json({ success: true, codes: newCodes });
    } catch (e) { res.status(500).json({error: e.message}); }
    finally { if(conn) conn.end(); }
});

// 5. 管理员：获取所有用户
app.post('/api/admin/users', async (req, res) => {
    const { adminUser } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const [admins] = await conn.query("SELECT role FROM users WHERE username=? AND role='admin'", [adminUser]);
        if (admins.length === 0) return res.status(403).json({message: "无权操作"});

        const [users] = await conn.query("SELECT id, username, email, is_active, registration_date FROM users ORDER BY registration_date DESC");
        res.json({ success: true, users });
    } catch (e) { res.status(500).json({error: e.message}); }
    finally { if(conn) conn.end(); }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
