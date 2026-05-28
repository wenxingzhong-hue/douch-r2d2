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
        return {
            users: [{ id: 1, name: "管理员", role: "cto", group: "管理组", pwd: "ODg4OA==" }],
            tasks: { "1": { l1: [], l2: [], week: [] } }
        };
    }
    const doc = await dataCollection.findOne({ type: 'global_data' });
    if (!doc) {
        const defaultData = {
            type: 'global_data',
            users: [{ id: 1, name: "管理员", role: "cto", group: "管理组", pwd: "ODg4OA==" }],
            tasks: { "1": { l1: [], l2: [], week: [] } }
        };
        await dataCollection.insertOne(defaultData);
        return defaultData;
    }
    return doc;
}

// 将数据安全写入云数据库
async function writeData(data) {
    await initDB();
    if (!dataCollection) return;
    await dataCollection.updateOne(
        { type: 'global_data' },
        { $set: { users: data.users, tasks: data.tasks } },
        { upsert: true }
    );
}

/* ==================== API 接口路由 ==================== */

// 1. 获取所有用户列表
app.get('/api/users', async (req, res) => {
    try {
        const data = await readData();
        res.json(data.users);
    } catch (err) {
        res.status(500).json({ ok: false, msg: "获取用户列表失败" });
    }
});

// 2. 登录验证占位接口
app.post('/api/login', (req, res) => {
    res.json({ ok: true });
});

// 3. 获取特定用户的任务数据（**已在此处完美集成多级联动排序逻辑**）
app.get('/api/task/:uid', async (req, res) => {
    try {
        const uid = req.params.uid;
        const data = await readData();
        const userTasks = data.tasks[uid] || { l1: [], l2: [], week: [] };

        // ==================== 核心排序逻辑开始 ====================
        
        // 1. 一级任务汇总排序：按完成时间（时间列）最早的排在最上面（升序）
        if (userTasks.l1 && Array.isArray(userTasks.l1)) {
            userTasks.l1.sort((a, b) => {
                // 自动兼容 time 或 date 字段
                const timeA = new Date(a.time || a.date || 0).getTime();
                const timeB = new Date(b.time || b.date || 0).getTime();
                return timeA - timeB; // 最早的排在最上面
            });
        }

        // 2. 二级任务汇总排序
        if (userTasks.l2 && Array.isArray(userTasks.l2)) {
            // 首先建立一个“一级任务标识(id或name)”到“一级任务时间”的映射表，提高匹配效率
            const l1TimeMap = {};
            if (userTasks.l1 && Array.isArray(userTasks.l1)) {
                userTasks.l1.forEach(item => {
                    const key = item.id || item.name;
                    if (key) {
                        l1TimeMap[key] = new Date(item.time || item.date || 0).getTime();
                    }
                });
            }

            userTasks.l2.sort((a, b) => {
                // 获取二级任务所关联的一级任务标识（自动兼容各类常见命名：parentId, l1Id, pId, l1Name, parent）
                const aParentKey = a.parentId || a.l1Id || a.pId || a.l1Name || a.parent;
                const bParentKey = b.parentId || b.l1Id || b.pId || b.l1Name || b.parent;

                const aL1Time = l1TimeMap[aParentKey] || 0;
                const bL1Time = l1TimeMap[bParentKey] || 0;

                // 【规则一】：先按所属的“一级任务完成时间”最早的排在最上面
                if (aL1Time !== bL1Time) {
                    return aL1Time - bL1Time;
                }

                // 【规则二】：如果属于同一个一级任务（时间相同），则按“二级任务自身时间”最早的排在最上面
                const aTime = new Date(a.time || a.date || 0).getTime();
                const bTime = new Date(b.time || b.date || 0).getTime();
                return aTime - bTime;
            });
        }

        // ==================== 核心排序逻辑结束 ====================

        res.json(userTasks);
    } catch (err) {
        console.error("获取任务失败:", err);
        res.status(500).json({ ok: false, msg: "获取任务失败" });
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
        res.status(500).json({ ok: false, msg: "更新密码失败" });
    }
});

// 兜底路由：确保刷新页面时也能正确导向主页
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`服务器正运行在端口: ${PORT}`);
});
