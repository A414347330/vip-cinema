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
// 假设你的静态文件（login.html等）在 public 文件夹下
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

        // 3. 用户表结构升级
        // 确保字段存在，如果不存在则添加
        const [columns] = await conn.query("SHOW COLUMNS FROM users");
        const colNames = columns.map(c => c.Field);

        if (!colNames.includes('role')) {
            await conn.query("ALTER TABLE users ADD COLUMN role VARCHAR(20) DEFAULT 'user'");
            console.log("💡 已自动添加 role 字段");
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
        console.error("❌ 数据库初始化失败，请检查配置:", err.message);
    } finally {
        if (conn) await conn.end();
    }
}

// 执行初始化
initDB();

// --- API 接口 ---

/**
 * 核心登录接口
 */
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
            let user = users[0];
            
            // --- 管理员权限硬编码补丁 ---
            // 只要是这个账号登录，无论数据库里是什么，强制设为 admin
            let finalRole = user.role || 'user';
            if (user.username === '16655039535' || user.email === '16655039535') {
                finalRole = 'admin';
                console.log(`[Login] 特权账号登录: ${user.username}, 已赋予 admin 权限`);
            } else {
                console.log(`[Login] 普通账号登录: ${user.username}, 角色为: ${finalRole}`);
            }

            // VIP 过期检查逻辑
            let isActive = user.is_active;
            if (isActive && user.vip_expire_time) {
                if (new Date() > new Date(user.vip_expire_time)) {
                    isActive = 0;
                }
            }

            // 返回给前端
            res.json({
                success: true,
                user: {
                    id: user.user_id || user.id,
                    username: user.username,
                    role: finalRole, // 这里是决定前端跳转的关键
                    is_active: isActive,
                    vip_expire_time: user.vip_expire_time
                }
            });
        } else {
            console.log(`[Login] 登录失败: 账号或密码错误 (${account})`);
            res.status(401).json({ success: false, message: "账号或密码错误" });
        }
    } catch (e) {
        console.error("[Login Error]", e.message);
        res.status(500).json({ error: e.message });
    } finally {
        if (conn) conn.end();
    }
});

/**
 * 其他管理端接口 (保持原有逻辑)
 */

// 激活码激活
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
            res.json({ success: true, message: `激活成功！有效期至 ${expireDate.toLocaleDateString()}` });
        } else {
            res.status(400).json({ success: false, message: "激活码无效" });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

// 管理员：生成激活码
app.post('/api/admin/generate', async (req, res) => {
    const { adminUser, count, duration } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const [admins] = await conn.query("SELECT role FROM users WHERE (username=? OR id=?) AND role='admin'", [adminUser, adminUser]);
        if (admins.length === 0 && adminUser !== '16655039535') return res.status(403).json({message: "无权操作"});

        const newCodes = [];
        const days = parseInt(duration) || 365;
        for(let i=0; i<(count || 1); i++) {
            const code = `VIP${days}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
            await conn.query("INSERT INTO activation_codes (code, duration_days) VALUES (?, ?)", [code, days]);
            newCodes.push({code, days});
        }
        res.json({ success: true, codes: newCodes });
    } catch (e) { res.status(500).json({error: e.message}); }
    finally { if(conn) conn.end(); }
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`✅ 服务已启动: http://localhost:${PORT}`);
    console.log(`👉 管理员账号补丁已启用: 16655039535`);
    console.log(`=========================================`);
});
// 1. 获取激活码列表 (支持筛选)
app.post('/api/admin/codes/list', async (req, res) => {
    const { adminUser, filter } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        let sql = "SELECT * FROM activation_codes";
        if (filter === 'used') sql += " WHERE is_used = 1";
        if (filter === 'unused') sql += " WHERE is_used = 0";
        sql += " ORDER BY create_time DESC LIMIT 100";
        const [rows] = await conn.query(sql);
        res.json({ success: true, codes: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

// 2. 作废/删除激活码
app.post('/api/admin/codes/delete', async (req, res) => {
    const { id } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        await conn.query("DELETE FROM activation_codes WHERE id = ?", [id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

// 3. 批量删除用户
app.post('/api/admin/users/batch_delete', async (req, res) => {
    const { ids } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        await conn.query("DELETE FROM users WHERE id IN (?)", [ids]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});

// 4. 编辑用户信息 (修改角色和VIP时长)
app.post('/api/admin/users/update', async (req, res) => {
    const { targetId, newRole, addDays } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        // 更新角色
        await conn.query("UPDATE users SET role = ? WHERE id = ?", [newRole, targetId]);
        // 更新VIP天数 (如果 addDays > 0)
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

// 5. 查看验证码记录 (方便管理员手动告知用户)
app.post('/api/admin/captchas', async (req, res) => {
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const [rows] = await conn.query("SELECT * FROM email_code_temp ORDER BY create_time DESC LIMIT 20");
        res.json({ success: true, logs: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.end(); }
});
