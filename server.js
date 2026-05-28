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

// 【高级兼容】从数据库读取整网数据（自动识别并找回老数据）
async function readData() {
    await initDB();
    if (!dataCollection) {
        return {
            users: [{ id: 1, name: "管理员", role: "cto", group: "管理组", pwd: "ODg4OA==" }],
            tasks: { "1": { l1: [], l2: [], week: [] } }
        };
    }

    // 获取集合中的所有文档进行智能辨别
    const docs = await dataCollection.find({}).toArray();
    
    if (docs.length === 0) {
        // 如果集合完全为空，则初始化默认数据
        const defaultData = {
            type: 'global_data',
            users: [{ id: 1, name: "管理员", role: "cto", group: "管理组", pwd: "ODg4OA==" }],
            tasks: { "1": { l1: [], l2: [], week: [] } }
        };
        await dataCollection.insertOne(defaultData);
        return defaultData;
    }

    // 【核心找回逻辑】优先寻找包含多个用户或多组任务的历史真正文档
    let realDoc = docs.find(d => d.users && d.users.length > 1);
    if (!realDoc) {
        realDoc = docs.find(d => d.tasks && Object.keys(d.tasks).length > 1);
    }
    if (!realDoc) {
        // 排除掉上一版代码误创建的 type 为 'global_data' 且只有1个用户的空白文档
        realDoc = docs.find(d => d.type !== 'global_data');
    }
    if (!realDoc) {
        // 兜底选择第一个文档
        realDoc = docs[0];
    }

    return realDoc;
}

// 【精准持久化】将数据安全写入云数据库
async function writeData(data) {
    await initDB();
    if (!dataCollection) return;
    
    if (data._id) {
        // 如果包含数据库内部 _id，说明是读取出来的历史有效文档，进行精准覆盖更新
        const { _id, ...updateFields } = data;
        await dataCollection.updateOne({ _id: _id }, { $set: updateFields });
    } else {
        // 兜底方案
        await dataCollection.updateOne(
            { type: 'global_data' },
            { $set: { users: data.users, tasks: data.tasks } },
            { upsert: true }
        );
    }
}

/* ==================== 排序辅助工具函数（超强容错） ==================== */

// 安全提取并解析各类日期/时间字段
function getTaskTime(task) {
    if (!task) return 0;
    const val = task.time || task.date || task.datetime || task.endTime || task.dateTime || 0;
    if (!val) return 0;
    const ts = Date.parse(val);
    return isNaN(ts) ? 0 : ts;
}

// 安全提取一级任务标识（支持 id 或名称）
function getL1Key(item) {
    if (!item) return '';
    return item.id || item.name || item.l1Name || item.title || '';
}

// 安全提取二级任务中关联一级任务的外键字段
function getParentKey(task) {
    if (!task) return '';
    return task.parentId || task.l1Id || task.pId || task.l1Name || task.parent || task.l1 || '';
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

// 3. 获取特定用户的任务数据（完美集成多级联动排序）
app.get('/api/task/:uid', async (req, res) => {
    try {
        const uid = req.params.uid;
        const data = await readData();
        const userTasks = data.tasks[uid] || { l1: [], l2: [], week: [] };

        // 1. 一级任务汇总排序：按完成时间（时间列）最早的排在最上面（升序）
        if (userTasks.l1 && Array.isArray(userTasks.l1)) {
            userTasks.l1.sort((a, b) => getTaskTime(a) - getTaskTime(b));
        }

        // 2. 二级任务汇总排序：先按一级任务时间升序，相同一级任务下按自身时间升序
        if (userTasks.l2 && Array.isArray(userTasks.l2)) {
            const l1TimeMap = {};
            if (userTasks.l1 && Array.isArray(userTasks.l1)) {
                userTasks.l1.forEach(item => {
                    const key = getL1Key(item);
                    if (key) {
                        l1TimeMap[key] = getTaskTime(item);
                    }
                });
            }

            userTasks.l2.sort((a, b) => {
                const aParentKey = getParentKey(a);
                const bParentKey = getParentKey(b);

                const aL1Time = l1TimeMap[aParentKey] || 0;
                const bL1Time = l1TimeMap[bParentKey] || 0;

                // 【规则一】优先按所属的“一级任务完成时间”升序排列
                if (aL1Time !== bL1Time) {
                    return aL1Time - bL1Time;
                }

                // 【规则二】若属于同一个一级任务，则按“二级任务自身完成时间”升序排列
                return getTaskTime(a) - getTaskTime(b);
            });
        }

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

// 兜底路由
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`服务器正运行在端口: ${PORT}`);
});
