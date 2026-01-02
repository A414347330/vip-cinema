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

const dbConfig = {
    host: 'mysql6.sqlpub.com',
    port: 3311,
    user: 'gileg_root',
    password: 'vKK4UFJJv0aGFCFX',
    database: 'gilegcn_mysql',
    connectTimeout: 20000,
    ssl: { rejectUnauthorized: false }
};

// --- 数据库初始化与结构自动修复 ---
async function initDB() {
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        console.log("🚀 正在同步数据库结构...");

        // 1. 确保 role, is_active, vip_expire_time 字段存在
        const [columns] = await conn.query("SHOW COLUMNS FROM users");
        const colNames = columns.map(c => c.Field.toLowerCase());

        if (!colNames.includes('role')) await conn.query("ALTER TABLE users ADD COLUMN role VARCHAR(20) DEFAULT 'user'");
        if (!colNames.includes('is_active')) await conn.query("ALTER TABLE users ADD COLUMN is_active TINYINT(1) DEFAULT 0");
        if (!colNames.includes('vip_expire_time')) await conn.query("ALTER TABLE users ADD COLUMN vip_expire_time DATETIME DEFAULT NULL");

        console.log("✅ 数据库结构检查完毕");
    } catch (err) { console.error("❌ 初始化失败:", err.message); }
    finally { if (conn) await conn.end(); }
}
initDB();

// --- 辅助函数：获取用户表的主键字段名 ---
async function getPrimaryKeyName(conn) {
    const [rows] = await conn.query("SHOW KEYS FROM users WHERE Key_name = 'PRIMARY'");
    return rows.length > 0 ? rows[0].Column_name : 'id';
}

// --- 核心 API ---

// 1. 登录
app.post('/api/login', async (req, res) => {
    const { account, password } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const pk = await getPrimaryKeyName(conn);
        // 使用 pk AS id 统一前端字段名
        const [users] = await conn.query(
            `SELECT *, ${pk} AS id FROM users WHERE (username=? OR email=?) AND password_hash=?`, 
            [account, account, password]
        );
        
        if (users.length > 0) {
            let user = users[0];
            let finalRole = user.role || 'user';
            if (user.username === '16655039535') finalRole = 'admin';

            res.json({
                success: true,
                user: { id: user.id, username: user.username, role: finalRole, is_active: user.is_active }
            });
        } else {
            res.status(401).json({ success: false, message: "账号或密码错误" });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

// 2. 获取用户列表 (修复 ID 字段报错)
app.post('/api/admin/users', async (req, res) => {
    const { adminUser, search } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const pk = await getPrimaryKeyName(conn); // 自动获取主键名，可能是 id 或 user_id
        
        let sql = `SELECT ${pk} AS id, username, email, role, is_active, vip_expire_time FROM users`;
        let params = [];
        if (search) {
            sql += " WHERE username LIKE ? OR email LIKE ?";
            params = [`%${search}%`, `%${search}%`];
        }
        const [rows] = await conn.query(sql + ` ORDER BY ${pk} DESC`, params);
        res.json({ success: true, users: rows });
    } catch (e) { 
        console.error(e);
        res.status(500).json({ success: false, error: e.message }); 
    }
    finally { if (conn) conn.end(); }
});

// 3. 删除用户
app.post('/api/admin/delete_user', async (req, res) => {
    const { targetId } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const pk = await getPrimaryKeyName(conn);
        await conn.query(`DELETE FROM users WHERE ${pk} = ?`, [targetId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

// 4. 获取激活码列表
app.post('/api/admin/codes/list', async (req, res) => {
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const { filter } = req.body;
        let sql = "SELECT * FROM activation_codes";
        if (filter === 'used') sql += " WHERE is_used = 1";
        if (filter === 'unused') sql += " WHERE is_used = 0";
        const [rows] = await conn.query(sql + " ORDER BY create_time DESC");
        res.json({ success: true, codes: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

// 5. 生成激活码
app.post('/api/admin/generate', async (req, res) => {
    const { count, duration } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        for(let i=0; i<count; i++) {
            const code = `VIP${duration}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
            await conn.query("INSERT INTO activation_codes (code, duration_days) VALUES (?, ?)", [code, duration]);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

// 6. 查看验证码记录
app.post('/api/admin/captchas', async (req, res) => {
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const [rows] = await conn.query("SELECT email, code, create_time FROM email_code_temp ORDER BY create_time DESC LIMIT 50");
        res.json({ success: true, logs: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

// 7. 更新用户 (编辑)
app.post('/api/admin/users/update', async (req, res) => {
    const { targetId, newRole, addDays } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const pk = await getPrimaryKeyName(conn);
        await conn.query(`UPDATE users SET role = ? WHERE ${pk} = ?`, [newRole, targetId]);
        if (parseInt(addDays) > 0) {
            await conn.query(`UPDATE users SET is_active = 1, vip_expire_time = DATE_ADD(IFNULL(vip_expire_time, NOW()), INTERVAL ? DAY) WHERE ${pk} = ?`, [addDays, targetId]);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
// 确保这个接口在 index.js 中存在
app.post('/api/activate', async (req, res) => {
    const { username, code } = req.body; // 必须是 username 和 code
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        
        // 1. 检查激活码
        const [codes] = await conn.query("SELECT * FROM activation_codes WHERE code=? AND is_used=0", [code]);
        
        if (codes.length > 0) {
            const days = codes[0].duration_days || 30;
            const pk = await getPrimaryKeyName(conn); // 自动获取主键名

            // 2. 更新激活码状态
            await conn.query("UPDATE activation_codes SET is_used=1, used_by=? WHERE code=?", [username, code]);
            
            // 3. 更新用户 VIP 状态 (注意这里使用 pk 获取主键名)
            await conn.query(`
                UPDATE users 
                SET is_active = 1, 
                vip_expire_time = DATE_ADD(IFNULL(vip_expire_time, NOW()), INTERVAL ? DAY) 
                WHERE username = ?`, [days, username]);
            
            res.json({ success: true, message: "激活成功" });
        } else {
            res.status(400).json({ success: false, message: "激活码无效或已被使用" });
        }
    } catch (e) {
        console.error("激活失败详情:", e); // 这里的报错会在你 node 的黑窗口显示
        res.status(500).json({ success: false, error: e.message });
    } finally {
        if (conn) conn.end();
    }
});
