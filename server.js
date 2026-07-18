const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');

const SORT_ASCENDING = false; 

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let dbClient = null;
let dataCollection = null;

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

async function readData() {
    await initDB();
    if (!dataCollection) {
        return {
            users: [{ id: 1, name: "管理员", role: "cto", group: "管理组", pwd: "ODg4OA==" }],
            tasks: { "1": { l1: [], l2: [], week: [] } }
        };
    }

    const docs = await dataCollection.find({}).toArray();
    
    if (docs.length === 0) {
        const defaultData = {
            type: 'global_data',
            users: [{ id: 1, name: "管理员", role: "cto", group: "管理组", pwd: "ODg4OA==" }],
            tasks: { "1": { l1: [], l2: [], week: [] } }
        };
        await dataCollection.insertOne(defaultData);
        return defaultData;
    }

    let realDoc = docs.find(d => d.users && d.users.length > 1);
    if (!realDoc) {
        realDoc = docs.find(d => d.tasks && Object.keys(d.tasks).length > 1);
    }
    if (!realDoc) {
        realDoc = docs.find(d => d.type !== 'global_data');
    }
    if (!realDoc) {
        realDoc = docs[0];
    }

    return realDoc;
}

async function writeData(data) {
    await initDB();
    if (!dataCollection) return;
    
    if (data._id) {
        const { _id, ...updateFields } = data;
        await dataCollection.updateOne({ _id: _id }, { $set: updateFields });
    } else {
        await dataCollection.updateOne(
            { type: 'global_data' },
            { $set: { users: data.users, tasks: data.tasks } },
            { upsert: true }
        );
    }
}

function getTaskTime(task) {
    if (!task) return Infinity;
    let val = task.time || task.date || task.datetime || task.endTime || task.dateTime || task.completionTime;
    if (val === undefined || val === null || val === '') return Infinity;

    val = String(val).trim();

    let ts = Date.parse(val);
    if (!isNaN(ts)) return ts;

    const matches = val.match(/\d+/g);
    if (matches && matches.length >= 2) {
        let year = new Date().getFullYear();
        let month = parseInt(matches[0], 10);
        let day = parseInt(matches[1], 10);

        if (matches.length >= 3) {
            year = parseInt(matches[0], 10);
            if (String(matches[0]).length < 4 && String(matches[2]).length === 4) {
                year = parseInt(matches[2], 10);
                month = parseInt(matches[0], 10);
                day = parseInt(matches[1], 10);
            } else {
                month = parseInt(matches[1], 10);
                day = parseInt(matches[2], 10);
            }
        }

        const dateObj = new Date(year, month - 1, day);
        if (!isNaN(dateObj.getTime())) {
            return dateObj.getTime();
        }
    }

    return Infinity;
}

function compareTimes(aTime, bTime) {
    if (aTime === bTime) return 0;
    if (aTime === Infinity) return 1;
    if (bTime === Infinity) return -1;
    
    if (SORT_ASCENDING) {
        return aTime - bTime;
    } else {
        return bTime - aTime;
    }
}

app.get('/api/users', async (req, res) => {
    try {
        const data = await readData();
        res.json(data.users);
    } catch (err) {
        res.status(500).json({ ok: false, msg: "获取用户列表失败" });
    }
});

app.post('/api/login', (req, res) => {
    res.json({ ok: true });
});

app.get('/api/task/:uid', async (req, res) => {
    try {
        const uid = req.params.uid;
        const data = await readData();
        const userTasks = data.tasks[uid] || { l1: [], l2: [], week: [] };

        if (userTasks.l1 && Array.isArray(userTasks.l1)) {
            userTasks.l1.sort((a, b) => compareTimes(getTaskTime(a), getTaskTime(b)));
        }

        if (userTasks.l2 && Array.isArray(userTasks.l2)) {
            const l1TimeMap = new Map();
            if (userTasks.l1 && Array.isArray(userTasks.l1)) {
                userTasks.l1.forEach(item => {
                    const time = getTaskTime(item);
                    if (item.id !== undefined && item.id !== null) l1TimeMap.set(String(item.id), time);
                    if (item.name) l1TimeMap.set(String(item.name), time);
                    if (item.l1Name) l1TimeMap.set(String(item.l1Name), time);
                    if (item.title) l1TimeMap.set(String(item.title), time);
                });
            }

            function getParentL1Time(task) {
                const possibleParentKeys = [task.parentId, task.l1Id, task.pId, task.l1Name, task.parent, task.l1];
                for (const key of possibleParentKeys) {
                    if (key !== undefined && key !== null && key !== '') {
                        if (l1TimeMap.has(String(key))) {
                            return l1TimeMap.get(String(key));
                        }
                    }
                }
                return Infinity;
            }

            userTasks.l2.sort((a, b) => {
                const aParentTime = getParentL1Time(a);
                const bParentTime = getParentL1Time(b);

                if (aParentTime !== bParentTime) {
                    return compareTimes(aParentTime, bParentTime);
                }

                return compareTimes(getTaskTime(a), getTaskTime(b));
            });
        }

        res.json(userTasks);
    } catch (err) {
        console.error("获取任务失败:", err);
        res.status(500).json({ ok: false, msg: "获取任务失败" });
    }
});

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

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`服务器正运行在端口: ${PORT}`);
});
