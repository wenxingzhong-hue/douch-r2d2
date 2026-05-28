const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
// 托管 public 文件夹中的前端静态页面
app.use(express.static(path.join(__dirname, 'public')));

// 初始化本地 JSON 数据文件
function initData() {
    if (!fs.existsSync(DATA_FILE)) {
        const defaultData = {
            // 预设一个 CTO 管理员，初始密码为 8888（Base64编码为 ODg4OA==）
            users: [
                { id: 1, name: "管理员", role: "cto", group: "管理组", pwd: "ODg4OA==" }
            ],
            tasks: {
                "1": { l1: [], l2: [], week: [] }
            }
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2), 'utf8');
    }
}

function readData() {
    initData();
    const content = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(content);
}

function writeData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/* ==================== API 接口路由 ==================== */

// 1. 获取所有用户列表
app.get('/api/users', (req, res) => {
    const data = readData();
    res.json(data.users);
});

// 2. 登录验证占位接口（前端负责比对密码，后端仅需返回成功）
app.post('/api/login', (req, res) => {
    res.json({ ok: true });
});

// 3. 获取特定用户的任务数据（**已在此处添加核心排序逻辑**）
app.get('/api/task/:uid', (req, res) => {
    const uid = req.params.uid;
    const data = readData();
    const userTasks = data.tasks[uid] || { l1: [], l2: [], week: [] };
    
    // ==================== 排序逻辑开始 ====================
    
    // 1. 一级任务汇总排序：按时间最早的排在最上面（升序）
    if (userTasks.l1 && Array.isArray(userTasks.l1)) {
        userTasks.l1.sort((a, b) => {
            // 兼容 time 或 date 字段，如果你的字段叫别的名字，请在此处修改
            const timeA = new Date(a.time || a.date || 0).getTime();
            const timeB = new Date(b.time || b.date || 0).getTime();
            return timeA - timeB; // 最早的排在最上面
        });
    }

    // 2. 二级任务汇总排序
    if (userTasks.l2 && Array.isArray(userTasks.l2) && userTasks.l1) {
        // 首先建立一个“一级任务ID/名称”到“一级任务时间”的映射表，方便二级任务快速查找
        const l1TimeMap = {};
        userTasks.l1.forEach(item => {
            const key = item.id || item.name;
            l1TimeMap[key] = new Date(item.time || item.date || 0).getTime();
        });

        userTasks.l2.sort((a, b) => {
            // 获取二级任务关联的一级任务标识（兼容 parentId, l1Id, pId, l1Name 等常见命名）
            const aParentKey = a.parentId || a.l1Id || a.pId || a.l1Name;
            const bParentKey = b.parentId || b.l1Id || b.pId || b.l1Name;

            const aL1Time = l1TimeMap[aParentKey] || 0;
            const bL1Time = l1TimeMap[bParentKey] || 0;

            // 规则一：先按所属的【一级任务时间】最早的排在最上面
            if (aL1Time !== bL1Time) {
                return aL1Time - bL1Time;
            }

            // 规则二：如果属于同一个一级任务（或对应一级任务时间相同），则按【二级任务自身时间】最早的排在最上面
            const aTime = new Date(a.time || a.date || 0).getTime();
            const bTime = new Date(b.time || b.date || 0).getTime();
            return aTime - bTime;
        });
    }
    
    // ==================== 排序逻辑结束 ====================

    res.json(userTasks);
});

// 4. 保存特定用户的任务数据
app.post('/api/task/save', (req, res) => {
    const { uid, data: userTasks } = req.body;
    if (!uid) return res.status(400).json({ ok: false, msg: "缺少用户ID" });
    
    const data = readData();
    data.tasks[uid] = userTasks;
    writeData(data);
    res.json({ ok: true });
});

// 5. 管理员添加新用户
app.post('/api/user/add', (req, res) => {
    const { name, role, group, pwd } = req.body;
    if (!name || !role) return res.json({ ok: false, msg: "姓名和角色不能为空" });

    const data = readData();
    if (data.users.some(u => u.name === name)) {
        return res.json({ ok: false, msg: "该用户姓名已存在" });
    }

    const newId = data.users.length > 0 ? Math.max(...data.users.map(u => Number(u.id))) + 1 : 1;
    const newUser = { id: newId, name, role, group: group || "默认组", pwd: pwd || "ODg4OA==" };
    
    data.users.push(newUser);
    data.tasks[newId] = { l1: [], l2: [], week: [] };
    writeData(data);
    
    res.json({ ok: true });
});

// 6. 管理员编辑用户
app.post('/api/user/edit', (req, res) => {
    const { id, name, role, group } = req.body;
    const data = readData();
    const user = data.users.find(u => u.id == id);
    
    if (!user) return res.json({ ok: false, msg: "用户不存在" });
    
    user.name = name;
    user.role = role;
    user.group = group;
    writeData(data);
    
    res.json({ ok: true });
});

// 7. 管理员删除用户
app.post('/api/user/delete', (req, res) => {
    const { id } = req.body;
    const data = readData();
    
    data.users = data.users.filter(u => u.id != id);
    if (data.tasks[id]) {
        delete data.tasks[id];
    }
    writeData(data);
    
    res.json({ ok: true });
});

// 8. 用户修改/重置密码
app.post('/api/user/update-pwd', (req, res) => {
    const { id, pwd } = req.body;
    const data = readData();
    const user = data.users.find(u => u.id == id);
    
    if (!user) return res.json({ ok: false, msg: "用户不存在" });
    
    user.pwd = pwd;
    writeData(data);
    
    res.json({ ok: true });
});

// 兜底路由：确保刷新页面时也能正确导向主页
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`服务器正运行在端口: ${PORT}`);
});
