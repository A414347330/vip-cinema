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
