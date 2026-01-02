const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件配置
app.use(cors());
app.use(bodyParser.json());
// 静态文件目录 (请确保 login.html, admin_super.html 在此目录下)
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

// --- 数据库初始化逻辑 ---
async function initDB() {
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        console.log("-----------------------------------------");
        console.log("🚀 正在检查并升级数据库结构...");

        // 1. 验证码临时表
        await conn.query(`
            CREATE TABLE IF NOT EXISTS email_code_temp (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(100),
                code VARCHAR(10),
                create_time DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 2. 激活码表
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

        // 3. 用户表结构
        const [columns] = await conn.query("SHOW COLUMNS FROM users");
        const colNames = columns.map(c => c.Field);

        if (!colNames.includes('role')) {
            await conn.query("ALTER TABLE users ADD COLUMN role VARCHAR(20) DEFAULT 'user'");
        }
        if (!colNames.includes('is_active')) {
            await conn.query("ALTER TABLE users ADD COLUMN is_active TINYINT(1) DEFAULT 0");
        }
        if (!colNames.includes('vip_expire_time')) {
            await conn.query("ALTER TABLE users ADD COLUMN vip_expire_time DATETIME DEFAULT NULL");
        }

        console.log("✅ 数据库结构就绪");
        console.log("-----------------------------------------");

    } catch (err) {
        console.error("❌ 数据库初始化失败:", err.message);
    } finally {
        if (conn) await conn.end();
    }
}
initDB();

// --- 基础 API ---

// 登录接口 (含特权补丁)
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
            let user = users[0];
            let finalRole = user.role || 'user';
            
            // 特权账号补丁
            if (user.username === '16655039535' || user.email === '16655039535') {
                finalRole = 'admin';
            }

            let isActive = user.is_active;
            if (isActive && user.vip_expire_time && new Date() > new Date(user.vip_expire_time)) {
                isActive = 0;
            }

            res.json({
                success: true,
                user: {
                    id: user.id,
                    username: user.username,
                    role: finalRole,
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

// 普通用户激活码激活
app.post('/api/activate', async (req, res) => {
    const { username, code } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const [codes] = await conn.query("SELECT * FROM activation_codes WHERE code=? AND is_used=0", [code]);
        if (codes.length > 0) {
            const days = codes[0].duration_days || 365;
            const expireDate = new Date();
            expireDate.setDate(expireDate.getDate() + days);
            await conn.query("UPDATE activation_codes SET is_used=1, used_by=? WHERE code=?", [username, code]);
            await conn.query("UPDATE users SET is_active=1, vip_expire_time=? WHERE username=?", [expireDate, username]);
            res.json({ success: true, message: `激活成功！有效期增加 ${days} 天` });
        } else {
            res.status(400).json({ success: false, message: "激活码无效或已被使用" });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

// --- 管理员特权 API ---

// 校验管理员权限的函数
async function checkAdmin(adminUser, conn) {
    if (adminUser === '16655039535') return true;
    const [rows] = await conn.query("SELECT role FROM users WHERE (username=? OR id=?) AND role='admin'", [adminUser, adminUser]);
    return rows.length > 0;
}

// 1. 获取用户列表
app.post('/api/admin/users', async (req, res) => {
    const { adminUser, search } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        if (!await checkAdmin(adminUser, conn)) return res.status(403).json({message: "无权操作"});

        let sql = "SELECT id, username, email, role, is_active, vip_expire_time FROM users";
        let params = [];
        if (search) {
            sql += " WHERE username LIKE ? OR email LIKE ?";
            params = [`%${search}%`, `%${search}%`];
        }
        const [rows] = await conn.query(sql + " ORDER BY id DESC", params);
        res.json({ success: true, users: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

// 2. 删除单个用户
app.post('/api/admin/delete_user', async (req, res) => {
    const { adminUser, targetId } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        if (!await checkAdmin(adminUser, conn)) return res.status(403).json({message: "无权操作"});
        await conn.query("DELETE FROM users WHERE id = ?", [targetId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

// 3. 批量删除用户
app.post('/api/admin/users/batch_delete', async (req, res) => {
    const { adminUser, ids } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        if (!await checkAdmin(adminUser, conn)) return res.status(403).json({message: "无权操作"});
        await conn.query("DELETE FROM users WHERE id IN (?)", [ids]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

// 4. 编辑用户 (角色与VIP天数)
app.post('/api/admin/users/update', async (req, res) => {
    const { adminUser, targetId, newRole, addDays } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        if (!await checkAdmin(adminUser, conn)) return res.status(403).json({message: "无权操作"});
        
        await conn.query("UPDATE users SET role = ? WHERE id = ?", [newRole, targetId]);
        if (parseInt(addDays) > 0) {
            await conn.query(`
                UPDATE users 
                SET is_active = 1, 
                vip_expire_time = DATE_ADD(IFNULL(vip_expire_time, NOW()), INTERVAL ? DAY) 
                WHERE id = ?`, [addDays, targetId]);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

// 5. 生成激活码
app.post('/api/admin/generate', async (req, res) => {
    const { adminUser, count, duration } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        if (!await checkAdmin(adminUser, conn)) return res.status(403).json({message: "无权操作"});

        const newCodes = [];
        const days = parseInt(duration) || 30;
        for(let i=0; i<(count || 1); i++) {
            const code = `VIP${days}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
            await conn.query("INSERT INTO activation_codes (code, duration_days) VALUES (?, ?)", [code, days]);
            newCodes.push({code, days});
        }
        res.json({ success: true, codes: newCodes });
    } catch (e) { res.status(500).json({error: e.message}); }
    finally { if(conn) conn.end(); }
});

// 6. 获取激活码列表
app.post('/api/admin/codes/list', async (req, res) => {
    const { adminUser, filter } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        if (!await checkAdmin(adminUser, conn)) return res.status(403).json({message: "无权操作"});

        let sql = "SELECT * FROM activation_codes";
        if (filter === 'used') sql += " WHERE is_used = 1";
        if (filter === 'unused') sql += " WHERE is_used = 0";
        const [rows] = await conn.query(sql + " ORDER BY create_time DESC LIMIT 100");
        res.json({ success: true, codes: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

// 7. 作废/删除激活码
app.post('/api/admin/codes/delete', async (req, res) => {
    const { adminUser, id } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        if (!await checkAdmin(adminUser, conn)) return res.status(403).json({message: "无权操作"});
        await conn.query("DELETE FROM activation_codes WHERE id = ?", [id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

// 8. 查看验证码记录
app.post('/api/admin/captchas', async (req, res) => {
    const { adminUser } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        if (!await checkAdmin(adminUser, conn)) return res.status(403).json({message: "无权操作"});
        const [rows] = await conn.query("SELECT email, code, create_time FROM email_code_temp ORDER BY create_time DESC LIMIT 50");
        res.json({ success: true, logs: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

// 启动服务器 (放在最后)
app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`✅ 服务启动成功: http://localhost:${PORT}`);
    console.log(`👉 管理员账号补丁: 16655039535`);
    console.log(`=========================================`);
});
