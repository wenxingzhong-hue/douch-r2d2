const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI; // 从 Render 环境变量中安全读取数据库连接串

app.use(express.json());
// 托管 public 文件夹中的前端静态页面
app.use(express.static(path.join(__dirname, 'public')));

let dbClient = null;
let dataCollection = null;

// 初始化云数据库连接
async function initDB() {
    if (!MONGO_URI) {
        console.error("警告: 未配置 MONGO_URI 环境变量，数据将无法持久化！");
        return;
    }
    if (!dbClient) {
        try {
            dbClient = new MongoClient(MONGO_URI);
            await dbClient.connect();
            const db = dbClient.db('team_task_db');
            dataCollection = db.collection('global_store');
            console.log("成功连接到云数据库 MongoDB Atlas");
        } catch (err) {
            console.error("连接数据库失败:", err);
        }
    }
}

// 从数据库读取整网数据
async function readData() {
    await initDB();
    if (!dataCollection) {
        // 如果未配置数据库，返回默认结构保障程序不崩溃
        return {
            users: [{ id: 1, name: "管理员", role: "cto", group: "管理组", pwd: "ODg4OA==" }],
            tasks: { "1": { l1: [], l2: [], week: [] } }
        };
    }
    
    let doc = await dataCollection.findOne({ _id: 'global_data' });
    if (!doc) {
        // 如果数据库是空的，初始化默认管理员账号
        doc = {
            _id: 'global_data',
            users: [
                { id: 1, name: "管理员", role: "cto", group: "管理组", pwd: "ODg4OA==" }
            ],
            tasks: {
                "1": { l1: [], l2: [], week: [] }
            }
        };
        await dataCollection.insertOne(doc);
    }
    return doc;
}

// 将更新后的数据保存回数据库
async function writeData(data) {
    await initDB();
    if (dataCollection) {
        await dataCollection.updateOne(
            { _id: 'global_data' },
            { $set: { users: data.users, tasks: data.tasks } },
            { upsert: true }
        );
    }
}

/* ==================== API 接口路由 ==================== */

// 1. 获取所有用户列表
app.get('/api/users', async (req, res) => {
    try {
        const data = await readData();
        res.json(data.users);
    } catch (err) {
        res.status(500).json({ ok: false, msg: "读取数据失败" });
    }
});

// 2. 登录验证占位接口
app.post('/api/login', (req, res) => {
    res.json({ ok: true });
});

// 3. 获取特定用户的任务数据
app.get('/api/task/:uid', async (req, res) => {
    try {
        const uid = req.params.uid;
        const data = await readData();
        const userTasks = data.tasks[uid] || { l1: [], l2: [], week: [] };
        res.json(userTasks);
    } catch (err) {
        res.status(500).json({ ok: false, msg: "读取任务失败" });
    }
});

// 4. 保存特定用户的任务数据
app.post('/api/task/save', async (req, res) => {
    try {
        const { uid, data: userTasks } = req.body;
        if (!uid) return res.status(400).json({ ok: false, msg: "缺少用户ID" });
        
        const data = await readData();
        data.tasks[uid] = userTasks;
        await writeData(data);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ ok: false, msg: "保存任务失败" });
    }
});

// 5. 管理员添加新用户
app.post('/api/user/add', async (req, res) => {
    try {
        const { name, role, group, pwd } = req.body;
        if (!name || !role) return res.json({ ok: false, msg: "姓名和角色不能为空" });

        const data = await readData();
        if (data.users.some(u => u.name === name)) {
            return res.json({ ok: false, msg: "该用户姓名已存在" });
        }

        const newId = data.users.length > 0 ? Math.max(...data.users.map(u => Number(u.id))) + 1 : 1;
        const newUser = { id: newId, name, role, group: group || "默认组", pwd: pwd || "ODg4OA==" };
        
        data.users.push(newUser);
        data.tasks[newId] = { l1: [], l2: [], week: [] };
        await writeData(data);
        
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ ok: false, msg: "添加用户失败" });
    }
});

// 6. 管理员编辑用户
app.post('/api/user/edit', async (req, res) => {
    try {
        const { id, name, role, group } = req.body;
        const data = await readData();
        const user = data.users.find(u => u.id == id);
        
        if (!user) return res.json({ ok: false, msg: "用户不存在" });
        
        user.name = name;
        user.role = role;
        user.group = group;
        await writeData(data);
        
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ ok: false, msg: "编辑用户失败" });
    }
});

// 7. 管理员删除用户
app.post('/api/user/delete', async (req, res) => {
    try {
        const { id } = req.body;
        const data = await readData();
        
        data.users = data.users.filter(u => u.id != id);
        if (data.tasks[id]) {
            delete data.tasks[id];
        }
        await writeData(data);
        
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ ok: false, msg: "删除用户失败" });
    }
});

// 8. 用户修改/重置密码
app.post('/api/user/update-pwd', async (req, res) => {
    try {
        const { id, pwd } = req.body;
        const data = await readData();
        const user = data.users.find(u => u.id == id);
        
        if (!user) return res.json({ ok: false, msg: "用户不存在" });
        
        user.pwd = pwd;
        await writeData(data);
        
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ ok: false, msg: "修改密码失败" });
    }
});

// 兜底路由：确保刷新页面时也能正确导向主页
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`服务器正运行在端口: ${PORT}`);
});
