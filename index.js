const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();

// Zeabur 会注入 PORT（默认 8080）；另外保留 ZEABUR_PORT 兜底
const PORT = Number(process.env.PORT || process.env.ZEABUR_PORT || 8080);
// 在 Zeabur 这类平台必须绑定 0.0.0.0（不要跟随 HOST 环境变量，避免被误配成 localhost）
const HOST = '0.0.0.0';


// 记录未捕获异常，方便在 Zeabur 日志里直接定位崩溃原因
process.on('unhandledRejection', (reason) => {
    console.error('❌ UnhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('❌ UncaughtException:', err);
    // 让平台接管重启（Zeabur 会自动拉起）
    process.exit(1);
});

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// 根路由兜底（防止某些静态托管/路由配置导致 / 404）
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 健康检查：用于 Zeabur 探活/你自己访问排查
app.get('/health', (req, res) => {
    res.json({
        ok: true,
        time: new Date().toISOString(),
        port: PORT,
        host: HOST,
        node: process.version,
        envPort: process.env.PORT || null
    });
});



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

// --- 辅助函数：获取表的主键字段名 ---
async function getTablePrimaryKeyName(conn, table) {
    const allowList = new Set(['users', 'activation_codes', 'email_code_temp']);
    const safeTable = allowList.has(table) ? table : 'users';
    const [rows] = await conn.query(`SHOW KEYS FROM ${safeTable} WHERE Key_name = 'PRIMARY'`);
    return rows.length > 0 ? rows[0].Column_name : 'id';
}

// --- 辅助函数：获取用户表的主键字段名 ---
async function getPrimaryKeyName(conn) {
    return await getTablePrimaryKeyName(conn, 'users');
}

// --- 兼容接口：前端直连 SQL (register.html 依赖) ---
// 注意：为避免被滥用，这里只允许对 users / email_code_temp 做 SELECT/INSERT。
app.post('/api/mysql', async (req, res) => {
    const body = req.body || {};
    const sql = String(body.sql || '').trim();
    const params = Array.isArray(body.params) ? body.params : [];

    if (!sql) {
        return res.status(400).json({ success: false, message: 'sql 不能为空' });
    }

    // 基础防注入/防破坏：禁用注释与危险关键字
    if (/--|\/\*|\*\//.test(sql)) {
        return res.status(400).json({ success: false, message: 'SQL 含非法注释' });
    }

    if (/\b(drop|alter|truncate|update|delete|create|grant|revoke)\b/i.test(sql)) {
        return res.status(400).json({ success: false, message: '不允许的 SQL 操作' });
    }

    // 逐语句校验（支持 register.html 的多语句 SELECT）
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
    if (statements.length === 0) {
        return res.status(400).json({ success: false, message: 'SQL 为空' });
    }

    const allowTables = ['users', 'email_code_temp'];
    for (const s of statements) {
        const head = s.slice(0, 20).toLowerCase();
        const isSelect = /^select\b/i.test(s);
        const isInsert = /^insert\b/i.test(s);
        if (!isSelect && !isInsert) {
            return res.status(400).json({ success: false, message: '仅允许 SELECT/INSERT' });
        }

        if (isSelect) {
            const m = s.match(/\bfrom\s+([a-zA-Z0-9_]+)/i);
            const t = (m && m[1]) ? m[1].toLowerCase() : '';
            if (!allowTables.includes(t)) {
                return res.status(400).json({ success: false, message: '不允许查询该表' });
            }
        }

        if (isInsert) {
            const m = s.match(/\binto\s+([a-zA-Z0-9_]+)/i);
            const t = (m && m[1]) ? m[1].toLowerCase() : '';
            if (!allowTables.includes(t)) {
                return res.status(400).json({ success: false, message: '不允许写入该表' });
            }
        }

        // 额外阻断系统库
        if (/\binformation_schema\b|\bmysql\b|\bperformance_schema\b|\bsys\b/i.test(s)) {
            return res.status(400).json({ success: false, message: '非法库访问' });
        }
    }

    let conn;
    try {
        conn = await mysql.createConnection({ ...dbConfig, multipleStatements: true });
        const [result] = await conn.query(sql, params);
        // 兼容 register.html：多语句时 result 为数组
        return res.json(result);
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        if (conn) conn.end();
    }
});

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

// 2. 获取用户列表（支持分页）
app.post('/api/admin/users', async (req, res) => {
    const { adminUser, search, page = 1, pageSize = 10 } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const pk = await getPrimaryKeyName(conn); // 自动获取主键名，可能是 id 或 user_id

        const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 10, 1), 50);
        const safePage = Math.max(parseInt(page, 10) || 1, 1);
        const offset = (safePage - 1) * safePageSize;

        let where = '';
        let params = [];
        if (search) {
            where = " WHERE username LIKE ? OR email LIKE ?";
            params = [`%${search}%`, `%${search}%`];
        }

        // 总数
        const [countRows] = await conn.query(`SELECT COUNT(*) AS total FROM users${where}`, params);
        const total = (countRows && countRows[0] && countRows[0].total) ? Number(countRows[0].total) : 0;

        // 分页数据
        const listSql = `SELECT ${pk} AS id, username, email, role, is_active, vip_expire_time FROM users${where} ORDER BY ${pk} DESC LIMIT ? OFFSET ?`;
        const [rows] = await conn.query(listSql, [...params, safePageSize, offset]);

        res.json({ success: true, users: rows, page: safePage, pageSize: safePageSize, total });
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

// 4. 获取激活码列表（支持分页 + 搜索）
app.post('/api/admin/codes/list', async (req, res) => {
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const { filter, page = 1, pageSize = 10, search } = req.body;

        const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 10, 1), 50);
        const safePage = Math.max(parseInt(page, 10) || 1, 1);
        const offset = (safePage - 1) * safePageSize;

        const pk = await getTablePrimaryKeyName(conn, 'activation_codes');

        const whereParts = [];
        const params = [];

        if (filter === 'used') whereParts.push('is_used = 1');
        if (filter === 'unused') whereParts.push('is_used = 0');

        const keyword = String(search || '').trim();
        if (keyword) {
            whereParts.push('(code LIKE ? OR used_by LIKE ?)');
            params.push(`%${keyword}%`, `%${keyword}%`);
        }

        const whereSql = whereParts.length ? (' WHERE ' + whereParts.join(' AND ')) : '';

        const [countRows] = await conn.query(`SELECT COUNT(*) AS total FROM activation_codes${whereSql}`, params);
        const total = (countRows && countRows[0] && countRows[0].total) ? Number(countRows[0].total) : 0;

        const [rows] = await conn.query(
            `SELECT ${pk} AS id, code, duration_days, is_used, used_by, create_time FROM activation_codes${whereSql} ORDER BY create_time DESC, ${pk} DESC LIMIT ? OFFSET ?`,
            [...params, safePageSize, offset]
        );

        res.json({ success: true, codes: rows, page: safePage, pageSize: safePageSize, total });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
    finally { if (conn) conn.end(); }
});

// 4.1 作废/删除激活码
app.post('/api/admin/codes/delete', async (req, res) => {
    const { id, code } = req.body || {};
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const pk = await getTablePrimaryKeyName(conn, 'activation_codes');

        if (id !== undefined && id !== null && id !== '') {
            await conn.query(`DELETE FROM activation_codes WHERE ${pk} = ?`, [id]);
            return res.json({ success: true });
        }

        if (code) {
            await conn.query('DELETE FROM activation_codes WHERE code = ?', [code]);
            return res.json({ success: true });
        }

        return res.status(400).json({ success: false, message: '缺少 id 或 code' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    } finally {
        if (conn) conn.end();
    }
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

// 6. 查看验证码记录（支持分页）
app.post('/api/admin/captchas', async (req, res) => {
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const { page = 1, pageSize = 10 } = req.body || {};

        const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 10, 1), 50);
        const safePage = Math.max(parseInt(page, 10) || 1, 1);
        const offset = (safePage - 1) * safePageSize;

        const pk = await getTablePrimaryKeyName(conn, 'email_code_temp');

        const [countRows] = await conn.query('SELECT COUNT(*) AS total FROM email_code_temp');
        const total = (countRows && countRows[0] && countRows[0].total) ? Number(countRows[0].total) : 0;

        const [rows] = await conn.query(
            `SELECT \`${pk}\` AS id, email, code, create_time FROM email_code_temp ORDER BY create_time DESC, \`${pk}\` DESC LIMIT ? OFFSET ?`,
            [safePageSize, offset]
        );

        res.json({ success: true, logs: rows, page: safePage, pageSize: safePageSize, total });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
    finally { if (conn) conn.end(); }
});

// 6.1 批量删除验证码记录（按主键 id）
app.post('/api/admin/captchas/delete', async (req, res) => {
    const { adminUser, ids } = req.body || {};

    if (!adminUser) {
        return res.status(400).json({ success: false, message: '缺少 adminUser' });
    }

    const list = Array.isArray(ids) ? ids.map(x => Number(x)).filter(n => Number.isFinite(n) && n > 0) : [];
    if (list.length === 0) {
        return res.status(400).json({ success: false, message: '未选择要删除的记录' });
    }
    if (list.length > 200) {
        return res.status(400).json({ success: false, message: '单次最多删除 200 条' });
    }

    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const pk = await getTablePrimaryKeyName(conn, 'email_code_temp');

        const [result] = await conn.query(
            `DELETE FROM email_code_temp WHERE ${pk} IN (?)`,
            [list]
        );

        return res.json({ success: true, affected: result && result.affectedRows ? result.affectedRows : 0 });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        if (conn) conn.end();
    }
});

// 7. 更新用户 (编辑)
app.post('/api/admin/users/update', async (req, res) => {
    const { targetId, newRole, addDays, vipActive } = req.body;
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const pk = await getPrimaryKeyName(conn);

        // 角色
        if (newRole) {
            await conn.query(`UPDATE users SET role = ? WHERE ${pk} = ?`, [newRole, targetId]);
        }

        // VIP 状态（0=普通，1=VIP）
        if (vipActive !== undefined && vipActive !== null && vipActive !== '') {
            const active = Number(vipActive) === 1 ? 1 : 0;
            if (active === 1) {
                await conn.query(`UPDATE users SET is_active = 1 WHERE ${pk} = ?`, [targetId]);
            } else {
                // 取消 VIP：同时清空到期时间
                await conn.query(`UPDATE users SET is_active = 0, vip_expire_time = NULL WHERE ${pk} = ?`, [targetId]);
            }
        }

        // 增加 VIP 天数：会强制激活 VIP
        if (parseInt(addDays) > 0) {
            await conn.query(
                `UPDATE users SET is_active = 1, vip_expire_time = DATE_ADD(IFNULL(vip_expire_time, NOW()), INTERVAL ? DAY) WHERE ${pk} = ?`,
                [addDays, targetId]
            );
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
    finally { if (conn) conn.end(); }
});

// 8. 获取当前登录用户信息（个人中心）
app.post('/api/user/me', async (req, res) => {
    const { id, username } = req.body || {};
    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        const pk = await getPrimaryKeyName(conn);

        let rows;
        if (id !== undefined && id !== null && id !== '') {
            [rows] = await conn.query(
                `SELECT ${pk} AS id, username, email, role, is_active, vip_expire_time, registration_date FROM users WHERE ${pk} = ? LIMIT 1`,
                [id]
            );
        } else if (username) {
            [rows] = await conn.query(
                `SELECT ${pk} AS id, username, email, role, is_active, vip_expire_time, registration_date FROM users WHERE username = ? LIMIT 1`,
                [username]
            );
        } else {
            return res.status(400).json({ success: false, message: '缺少用户标识' });
        }

        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: '用户不存在' });
        }

        const user = rows[0];
        // 兼容：管理员手机号固定提升权限
        const finalRole = (user.username === '16655039535') ? 'admin' : (user.role || 'user');

        return res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: finalRole,
                is_active: user.is_active,
                vip_expire_time: user.vip_expire_time,
                registration_date: user.registration_date
            }
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        if (conn) conn.end();
    }
});

// 9. 修改密码（个人中心）
app.post('/api/user/change_password', async (req, res) => {
    const { id, username, oldPasswordHash, newPasswordHash } = req.body || {};
    let conn;

    if (!newPasswordHash) {
        return res.status(400).json({ success: false, message: '新密码不能为空' });
    }
    if (!oldPasswordHash) {
        return res.status(400).json({ success: false, message: '旧密码不能为空' });
    }

    try {
        conn = await mysql.createConnection(dbConfig);
        const pk = await getPrimaryKeyName(conn);

        let rows;
        if (id !== undefined && id !== null && id !== '') {
            [rows] = await conn.query(
                `SELECT ${pk} AS id, username, password_hash FROM users WHERE ${pk} = ? LIMIT 1`,
                [id]
            );
        } else if (username) {
            [rows] = await conn.query(
                `SELECT ${pk} AS id, username, password_hash FROM users WHERE username = ? LIMIT 1`,
                [username]
            );
        } else {
            return res.status(400).json({ success: false, message: '缺少用户标识' });
        }

        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: '用户不存在' });
        }

        const u = rows[0];
        if (String(u.password_hash || '') !== String(oldPasswordHash || '')) {
            return res.status(400).json({ success: false, message: '旧密码不正确' });
        }

        await conn.query(
            `UPDATE users SET password_hash = ? WHERE ${pk} = ?`,
            [newPasswordHash, u.id]
        );

        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        if (conn) conn.end();
    }
});

app.listen(PORT, HOST, () => {
    console.log(`✅ Server listening on ${HOST}:${PORT}`);
    console.log(`✅ Health check: /health`);
});

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