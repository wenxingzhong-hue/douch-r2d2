const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');

// ==================== ⚙️ 排序方向全局配置 ⚙️ ====================
// 默认 true 代表升序（6月1日排在7月1日上面）。
// 如果部署后由于前端特殊的渲染机制导致汇总表依然反了，请直接把这里的 true 改为 false 即可！
const SORT_ASCENDING = true; 

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

// 从数据库读取整网数据（带历史老数据智能找回）
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

    // 优先寻找包含多个用户或多组任务的历史真正老数据文档
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

// 将数据安全写入云数据库
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

/* ==================== 🛠️ 深度增强：核心排序辅助工具函数 ==================== */

// 【特异功能】智能解析中文及各类不规范的日期字符串（如 "6月1日", "7月1日", "6/1", "2024年6月1日"）
function getTaskTime(task) {
    if (!task) return Infinity;
    let val = task.time || task.date || task.datetime || task.endTime || task.dateTime || task.completionTime;
    if (val === undefined || val === null || val === '') return Infinity;

    val = String(val).trim();

    // 1. 尝试标准国际日期格式直接解析 (如 "2024-06-01")
    let ts = Date.parse(val);
    if (!isNaN(ts)) return ts;

    // 2. 强力正则表达式：智能提取文本中的所有连续数字，精准识别中文日期
    const matches = val.match(/\d+/g);
    if (matches && matches.length >= 2) {
        let year = new Date().getFullYear(); // 默认使用今年
        let month = parseInt(matches[0], 10);
        let day = parseInt(matches[1], 10);

        // 如果提取到了3个及以上的数字，说明用户指定了年份 (如 "2024年6月1日" 或 "2024/6/1")
        if (matches.length >= 3) {
            year = parseInt(matches[0], 10);
            // 兼容有些年份写在后面的特殊习惯，判断四位数在哪里
            if (String(matches[0]).length < 4 && String(matches[2]).length === 4) {
                year = parseInt(matches[2], 10);
                month = parseInt(matches[0], 10);
                day = parseInt(matches[1], 10);
            } else {
                month = parseInt(matches[1], 10);
                day = parseInt(matches[2], 10);
            }
        }

        // 月份在 JS 中是 0-11，所以需要减 1
        const dateObj = new Date(year, month - 1, day);
        if (!isNaN(dateObj.getTime())) {
            return dateObj.getTime();
        }
    }

    return Infinity; // 完全无法识别的文字一律判定为无穷大（安全沉底）
}

// 严谨的时间比较器（支持全局一键反转）
function compareTimes(aTime, bTime) {
    if (aTime === bTime) return 0;
    if (aTime === Infinity) return 1;  // a没填时间，排到后面
    if (bTime === Infinity) return -1; // b没填时间，排到后面
    
    if (SORT_ASCENDING) {
        return aTime - bTime; // 升序：时间小的（早的，如6月1日）在上面
    } else {
        return bTime - aTime; // 降序：时间大的（晚的，如7月1日）在上面
    }
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

// 3. 获取特定用户的任务数据（✨ 完美树状联动升序排列 ✨）
app.get('/api/task/:uid', async (req, res) => {
    try {
        const uid = req.params.uid;
        const data = await readData();
        const userTasks = data.tasks[uid] || { l1: [], l2: [], week: [] };

        // 【步骤一】一级任务深度排序
        if (userTasks.l1 && Array.isArray(userTasks.l1)) {
            userTasks.l1.sort((a, b) => compareTimes(getTaskTime(a), getTaskTime(b)));
        }

        // 【步骤二】二级任务完美联动及内部独立时间排序
        if (userTasks.l2 && Array.isArray(userTasks.l2)) {
            // 构建一个高度容错的一级任务时间映射 Map
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

            // 安全找出二级任务对应的一级任务的完成时间
            function getParentL1Time(task) {
                const possibleParentKeys = [task.parentId, task.l1Id, task.pId, task.l1Name, task.parent, task.l1];
                for (const key of possibleParentKeys) {
                    if (key !== undefined && key !== null && key !== '') {
                        if (l1TimeMap.has(String(key))) {
                            return l1TimeMap.get(String(key));
                        }
                    }
                }
                return Infinity; // 找不到爸爸的一律靠后排
            }

            // 执行深度双重优先法则排序
            userTasks.l2.sort((a, b) => {
                const aParentTime = getParentL1Time(a);
                const bParentTime = getParentL1Time(b);

                // 【第一优先法则】先按所属一级任务的完成时间排序
                // 归属于6月1日一级任务的二级任务，整体排在归属于7月1日一级任务的二级任务上面
                if (aParentTime !== bParentTime) {
                    return compareTimes(aParentTime, bParentTime);
                }

                // 【第二优先法则】若归属于同一个一级任务，则按二级任务自身的完成时间排序
                return compareTimes(getTaskTime(a), getTaskTime(b));
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
