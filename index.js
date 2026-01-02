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

// --- 初始化/升级数据库 ---
async function initDB() {
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        console.log("正在检查数据库结构...");

        // 1. 验证码临时表
        await conn.query(`
            CREATE TABLE IF NOT EXISTS email_code_temp (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(100),
                code VARCHAR(10),
                create_time DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

// ...前面的代码不变...

// 登录接口
app.post('/api/login', async (req, res) => {
    const { account, password } = req.body;
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
            
            // 计算过期逻辑...
            let isActive = user.is_active;
            if (isActive && user.vip_expire_time) {
                if (new Date() > new Date(user.vip_expire_time)) isActive = 0;
            }

            // 【关键点在这里！！！】
            // 必须把 role: user.role 返回去
            res.json({
                success: true,
                user: {
                    id: user.user_id || user.id,
                    username: user.username,
                    role: user.role,  // <--- 这一行决不能少
                    is_active: isActive,
                    vip_expire_time: user.vip_expire_time
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

// ...后面的代码不变...
        // 2. 激活码表 (增加 duration_days 字段)
        await conn.query(`
            CREATE TABLE IF NOT EXISTS activation_codes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                code VARCHAR(50) UNIQUE NOT NULL,
                duration_days INT DEFAULT 365,
                is_used TINYINT(1) DEFAULT 0,
                used_by VARCHAR(100) DEFAULT NULL,
                create_time DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // 尝试添加 duration_days 字段(为了兼容老表)
        try { await conn.query("ALTER TABLE activation_codes ADD COLUMN duration_days INT DEFAULT 365"); } catch(e){}

        // 3. 用户表 (增加 vip_expire_time, is_active, role)
        // 尝试添加字段
        try { await conn.query("ALTER TABLE users ADD COLUMN is_active TINYINT(1) DEFAULT 0"); } catch(e){}
        try { await conn.query("ALTER TABLE users ADD COLUMN role VARCHAR(20) DEFAULT 'user'"); } catch(e){}
        try { await conn.query("ALTER TABLE users ADD COLUMN vip_expire_time DATETIME DEFAULT NULL"); } catch(e){}

        console.log("✅ 数据库结构检查/升级完成");

    } catch (err) {
        console.error("数据库初始化失败:", err);
    } finally {
        if (conn) await conn.end();
    }
}
initDB();

// --- API 接口 ---

// 1. 登录
app.post('/api/login', async (req, res) => {
    const { account, password } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const [users] = await conn.query(
            "SELECT * FROM users WHERE (username=? OR email=?) AND password_hash=?", 
            [account, account, password]
        );
        
        if (users.length > 0) {
            const user = users[0];
            // 检查VIP是否过期
            let isActive = user.is_active;
            if (isActive && user.vip_expire_time) {
                const now = new Date();
                const expire = new Date(user.vip_expire_time);
                if (now > expire) isActive = 0; // 已过期
            }

            res.json({
                success: true,
                user: {
                    id: user.user_id || user.id,
                    username: user.username,
                    role: user.role,
                    is_active: isActive,
                    vip_expire_time: user.vip_expire_time
                }
            });
        } else {
            res.status(401).json({ success: false, message: "账号或密码错误" });
        }
    } catch (e) { res.status(500).json({ error: e.message }); } 
    finally { if (conn) conn.end(); }
});

// 2. 激活 (带时长逻辑)
app.post('/api/activate', async (req, res) => {
    const { username, code } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        
        // 查激活码
        const [codes] = await conn.query("SELECT * FROM activation_codes WHERE code=? AND is_used=0", [code]);
        
        if (codes.length > 0) {
            const codeInfo = codes[0];
            const days = codeInfo.duration_days || 365;

            // 计算过期时间：当前时间 + 天数
            const expireDate = new Date();
            expireDate.setDate(expireDate.getDate() + days);

            // 更新激活码状态
            await conn.query("UPDATE activation_codes SET is_used=1, used_by=? WHERE code=?", [username, code]);
            
            // 更新用户 (激活 + 设置过期时间)
            await conn.query("UPDATE users SET is_active=1, vip_expire_time=? WHERE username=?", [expireDate, username]);
            
            res.json({ success: true, message: `激活成功！增加 ${days} 天VIP时长` });
        } else {
            res.status(400).json({ success: false, message: "激活码无效或已被使用" });
        }
    } catch (e) { res.status(500).json({ error: e.message }); } 
    finally { if (conn) conn.end(); }
});

// 3. 管理员：生成带时长的激活码
app.post('/api/admin/generate', async (req, res) => {
    const { adminUser, count, duration } = req.body; // duration 是天数
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        // 权限校验
        const [admins] = await conn.query("SELECT role FROM users WHERE username=? AND role='admin'", [adminUser]);
        if (admins.length === 0) return res.status(403).json({message: "无权操作"});

        const newCodes = [];
        const days = parseInt(duration) || 365; // 默认一年

        for(let i=0; i< (count || 1); i++) {
            // 生成随机码: VIP-天数-随机串
            const suffix = Math.random().toString(36).substr(2, 6).toUpperCase();
            const code = `VIP${days}-${suffix}`; // 例如 VIP30-KJ8SD9
            
            await conn.query("INSERT INTO activation_codes (code, duration_days) VALUES (?, ?)", [code, days]);
            newCodes.push({code, days});
        }
        res.json({ success: true, codes: newCodes });
    } catch (e) { res.status(500).json({error: e.message}); }
    finally { if(conn) conn.end(); }
});

// 4. 管理员：获取/搜索用户
app.post('/api/admin/users', async (req, res) => {
    const { adminUser, search } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        // 权限校验
        const [admins] = await conn.query("SELECT role FROM users WHERE username=? AND role='admin'", [adminUser]);
        if (admins.length === 0) return res.status(403).json({message: "无权操作"});

        let sql = "SELECT id, username, email, is_active, vip_expire_time, registration_date, role FROM users";
        let params = [];
        
        if (search) {
            sql += " WHERE username LIKE ? OR email LIKE ?";
            params = [`%${search}%`, `%${search}%`];
        }
        sql += " ORDER BY registration_date DESC LIMIT 50";

        const [users] = await conn.query(sql, params);
        res.json({ success: true, users });
    } catch (e) { res.status(500).json({error: e.message}); }
    finally { if(conn) conn.end(); }
});

// 5. 管理员：删除用户
app.post('/api/admin/delete_user', async (req, res) => {
    const { adminUser, targetId } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        // 权限
        const [admins] = await conn.query("SELECT role FROM users WHERE username=? AND role='admin'", [adminUser]);
        if (admins.length === 0) return res.status(403).json({message: "无权操作"});

        await conn.query("DELETE FROM users WHERE id=?", [targetId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({error: e.message}); }
    finally { if(conn) conn.end(); }
});

// 邮件验证码API保留
app.post('/api/mysql', async (req, res) => {
    const { sql, params } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const [rows] = await conn.query(sql, params);
        res.json(rows);
    } catch (e) { res.status(500).json({error: e.message}); }
    finally { if(conn) conn.end(); }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
