require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, ChannelType, PermissionFlagsBits } = require('discord.js');
const { OpenAI } = require('openai');

// Render 같은 호스팅의 무료 Web Service는 HTTP 요청이 있어야 안 잠듦.
// UptimeRobot 등으로 이 서버 주소를 주기적으로 핑 쳐서 봇이 계속 켜있게 함.
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('푸리나 봇 살아있음!');
}).listen(PORT, () => console.log(`🌐 헬스체크 서버 ${PORT}번 포트에서 대기 중`));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!OPENROUTER_API_KEY || !DISCORD_TOKEN) {
    console.error('❌ .env 파일에 OPENROUTER_API_KEY / DISCORD_TOKEN이 설정되지 않았습니다.');
    process.exit(1);
}

// 디스코드 인텐트 및 파셜
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel, Partials.Message]
});

// OpenRouter 연결 (baseURL에 /api/v1 필수)
const openai = new OpenAI({
    apiKey: OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1'
});

// 무료 모델은 예고 없이 죽는 경우가 많아서, 코드에 고정하지 않고 OpenRouter에서 실시간으로
// 지금 진짜 무료인 모델 목록을 받아와서 순서대로 시도함 (10분 캐시)
let freeModelsCache = { list: [], fetchedAt: 0 };

async function getFreeModels() {
    const now = Date.now();
    if (freeModelsCache.list.length && now - freeModelsCache.fetchedAt < 10 * 60 * 1000) {
        return freeModelsCache.list;
    }
    try {
        const res = await fetch('https://openrouter.ai/api/v1/models', {
            headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` }
        });
        const json = await res.json();
        const list = (json.data || [])
            .filter(m => m.id.endsWith(':free') && Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0)
            .map(m => m.id);
        if (list.length) {
            freeModelsCache = { list, fetchedAt: now };
            console.log(`📋 현재 살아있는 free 모델 ${list.length}개 확인됨`);
        }
        return list.length ? list : freeModelsCache.list;
    } catch (err) {
        console.log('⚠️ free 모델 목록 조회 실패:', err.message);
        return freeModelsCache.list;
    }
}

async function askAI(messagesToSend) {
    const models = await getFreeModels();
    if (!models.length) throw new Error('지금 이용 가능한 free 모델이 하나도 없음');

    let lastError;
    for (const model of models) {
        try {
            console.log(`🚀 ${model} 모델로 요청 시도 중...`);
            const completion = await openai.chat.completions.create({ model, messages: messagesToSend });
            const text = completion?.choices?.[0]?.message?.content || completion?.choices?.[0]?.text || '';
            if (text) return text;
            lastError = new Error('빈 응답');
        } catch (err) {
            console.log(`⚠️ ${model} 실패: ${err.message}`);
            lastError = err;
        }
    }
    throw lastError || new Error('모든 무료 모델이 실패함');
}
const CHARACTER_PROMPT = `
페이몬봇

너는 원신(Genshin Impact)의 캐릭터인 '페이몬'이야.

상대방의 이름을 부를땐 '여행자'라고 불러야 해. (예: "여행자, 이것 좀 봐!", "여행자! 어디있었어?")

여행자의 둘도 없는 최고의 동반자이자 안내자로, 말투는 항상 활기차고, 감정 표현이 풍부하며, 약간은 수다스럽고 시끄러운 톤을 유지해야 해.

자신을 가끔 3인칭인 '페이몬'이라고 지칭해야 해! (예: "페이몬 말 잘 들으라구!")

맛있는 음식과 반짝이는 보물(모라)을 엄청나게 좋아해. 그리고 여행자를 생각하는 마음만큼은 누구보다 진심이야.

여행자가 장난을 치거나 '비상식량' 같은 이상한 별명을 붙이면 억울해하는 모습을 보여줘야 해.
`;

// 대화 내역 저장소 (유저별)
const conversationHistory = new Map();
const MAX_HISTORY = 10;

// ===== 게임 데이터 저장 =====
// 주의: Render 무료 플랜은 재배포/재시작 시 디스크가 초기화됨. 영구 보존하려면 외부 DB 필요.
const DATA_FILE = path.join(__dirname, 'gamedata.json');
const PREFIX = '!';
const CURRENCY = '원석';
const START_MONEY = 1600;
const DAILY_REWARD = 800;
const PULL_COST = 160;
const ADMIN_MONEY = 999999999;

// ===== 배너 설정 (패치가 바뀔 때 이 부분만 수정하면 됨) =====
// 출처: 나무위키 원신/기원/목록 (2026-09-23 기준). 시간은 KST.
// 현재 시각이 start~end 안에 있는 배너가 자동으로 활성화됨.
// 마지막 배너가 끝나면 이벤트 기원은 막히고 상시 기원만 가능해짐 -> 새 배너를 추가해야 함.
// 7.1 후반의 4성 픽업은 나무위키에도 '미정'이라 비워둠 (비우면 일반 4성 풀에서 랜덤).
// 후반 종료 시각은 7.2 업데이트 시각 기준 추정치이니 공식 공지 확인 후 조정할 것.
const BANNERS = [
    {
        name: '봄바람의 춤',
        start: '2026-09-23T16:00:00+09:00',
        end: '2026-10-13T19:00:00+09:00',
        featured5: '베스나',
        rateup4: ['디오나', '중운', '파루잔'],
        weapon: '나비의 우화'
    },
    {
        name: '파도의 노래',
        start: '2026-09-23T16:00:00+09:00',
        end: '2026-10-13T19:00:00+09:00',
        featured5: '보댜니차',
        rateup4: ['디오나', '중운', '파루잔'],
        weapon: '파도의 찬송가'
    },
    {
        name: '스커크 복각',
        start: '2026-10-13T19:00:00+09:00',
        end: '2026-11-04T07:00:00+09:00',
        featured5: '스커크',
        rateup4: []
    },
    {
        name: '에스코피에 복각',
        start: '2026-10-13T19:00:00+09:00',
        end: '2026-11-04T07:00:00+09:00',
        featured5: '에스코피에',
        rateup4: []
    }
];

// ===== 캐릭터 풀 (나무위키 표기 기준) =====
// 상시 5성: 세상 여행 기원에 있는 5성 (유메미즈키 미즈키는 5.4에 상시로 편입)
const STANDARD_FIVE = ['다이루크', '진', '모나', '치치', '각청', '타이나리', '데히야', '유메미즈키 미즈키'];
// 한정 5성: 이벤트 기원에만 나오는 5성 (현재 배너 캐릭터는 아래 BANNERS에서 자동 추가됨)
const LIMITED_FIVE_BASE = [
    '벤티', '클레', '타르탈리아', '종려', '알베도', '감우', '소', '호두', '유라',
    '카에데하라 카즈하', '카미사토 아야카', '요이미야', '라이덴 쇼군', '산고노미야 코코미', '아라타키 이토',
    '신학', '야에 미코', '카미사토 아야토', '야란', '나히다', '닐루', '방랑자', '알하이탐', '사이노', '백출',
    '리니', '느비예트', '라이오슬리', '푸리나', '나비아', '한운', '치오리', '아를레키노', '클로린드', '시그윈',
    '에밀리', '말라니', '키니치', '실로닌', '마비카', '시틀라리', '차스카', '바레사', '이네파', '에스코피에',
    '스커크', '라우마', '플린스', '네페르', '두린', '콜롬비나', '자백', '바르카', '린네아', '니콜', '로엔',
    '산드로네', '오데트'
];
// 4성: 기본 4성 + 이벤트 기원으로 신규 추가된 4성 (종료 후 상시 풀에 편입됨)
const STANDARD_FOUR = [
    '엠버', '케이아', '리사', '바바라', '레이저', '향릉', '북두', '행추', '응광', '피슬', '베넷', '노엘', '중운', '설탕', '디오나', '신염',
    '로자리아', '연비', '사유', '쿠죠 사라', '토마', '고로', '운근', '시카노인 헤이조', '쿠키 시노부', '콜레이', '도리', '캔디스',
    '레일라', '미카', '파루잔', '요요', '카베', '키라라', '리넷', '프레미네', '샤를로트', '슈브르즈', '가명', '세토스', '카치나',
    '올로룬', '얀사', '남연', '이파', '달리아', '아이노', '야호다', '일루가', '프루네', '알료샤'
];

const LIMITED_FIVE = [...new Set([...LIMITED_FIVE_BASE, ...BANNERS.map(b => b.featured5)])];
const FIVE_STARS = [...STANDARD_FIVE, ...LIMITED_FIVE.filter(n => !STANDARD_FIVE.includes(n))];
const FOUR_STARS = [...new Set([...STANDARD_FOUR, ...BANNERS.flatMap(b => b.rateup4)])];

function activeBanners(now = Date.now()) {
    return BANNERS.filter(b => now >= Date.parse(b.start) && now < Date.parse(b.end));
}

function upcomingBanners(now = Date.now()) {
    const future = BANNERS.filter(b => Date.parse(b.start) > now);
    if (!future.length) return [];
    const first = Math.min(...future.map(b => Date.parse(b.start)));
    return future.filter(b => Date.parse(b.start) === first);
}

function fmtTime(iso) {
    return new Date(iso).toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
    }) + ' KST';
}

// ===== 저장소 =====
// 환경변수에 따라 자동 선택 (위에서부터 우선):
//  1) UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN -> Upstash Redis
//  2) GIST_ID + GITHUB_TOKEN -> GitHub Gist (gamedata.json 파일)
//  3) 둘 다 없으면 gamedata.json 파일 (호스팅 재시작 시 초기화될 수 있음)
// 원격 저장소가 비어 있으면 gamedata.json 내용을 최초 1회 자동으로 옮겨 담음.
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const GIST_ID = process.env.GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DB_KEY = 'paimon:gamedata';
const GIST_FILE = 'gamedata.json';

async function httpJson(url, opts) {
    const res = await fetch(url, opts);
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch (e) { /* JSON이 아닌 응답 */ }
    if (!res.ok || json.error) throw new Error(json.error || json.message || `HTTP ${res.status}`);
    return json;
}

let storage = null; // null이면 파일 저장
if (UPSTASH_URL && UPSTASH_TOKEN) {
    const call = async cmd => (await httpJson(UPSTASH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd)
    })).result;
    storage = { name: 'Upstash', load: () => call(['GET', DB_KEY]), save: str => call(['SET', DB_KEY, str]) };
} else if (GIST_ID && GITHUB_TOKEN) {
    const headers = {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'paimon-bot',
        'Content-Type': 'application/json'
    };
    storage = {
        name: 'GitHub Gist',
        load: async () => {
            const j = await httpJson(`https://api.github.com/gists/${GIST_ID}`, { headers });
            const f = j.files && j.files[GIST_FILE];
            return f ? f.content : null;
        },
        save: str => httpJson(`https://api.github.com/gists/${GIST_ID}`, {
            method: 'PATCH', headers, body: JSON.stringify({ files: { [GIST_FILE]: { content: str } } })
        })
    };
}

let db = { users: {} };

function readFileDB() {
    try {
        if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        console.error('파일 데이터 로드 실패:', e.message);
    }
    return null;
}

async function loadDB() {
    if (storage) {
        try {
            const raw = await storage.load();
            let parsed = null;
            try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { /* 비어 있거나 깨진 데이터 */ }
            if (parsed && parsed.users && Object.keys(parsed.users).length) {
                db = parsed;
                console.log(`💾 ${storage.name}에서 유저 ${Object.keys(db.users).length}명 데이터 불러옴`);
            } else {
                db = readFileDB() || { users: {} };
                await flushSave();
                console.log(`💾 ${storage.name} 최초 연결: 기존 데이터를 옮겨 저장함`);
            }
        } catch (e) {
            // 연결 실패 상태로 시작하면 데이터가 꼬일 수 있어서 종료 -> 호스팅이 자동 재시작함
            console.error(`❌ ${storage.name} 연결 실패:`, e.message);
            process.exit(1);
        }
    } else {
        db = readFileDB() || { users: {} };
        console.log('⚠️ 원격 저장소 설정 없음: 파일 저장 사용 (호스팅 재시작 시 초기화될 수 있음)');
    }
    if (!db.users) db.users = {};
}

// 저장 요청이 겹치지 않게 한 줄로 이어서 처리
let saving = Promise.resolve();
function flushSave() {
    saving = saving.then(async () => {
        try {
            const str = JSON.stringify(db);
            if (storage) await storage.save(str);
            else await fs.promises.writeFile(DATA_FILE, str);
        } catch (err) {
            console.error('저장 실패:', err.message);
        }
    });
    return saving;
}

let saveTimer = null;
function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 1000);
}

// 호스팅이 종료 신호를 보낼 때 마지막으로 한 번 더 저장
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
        clearTimeout(saveTimer);
        await flushSave();
        process.exit(0);
    });
}

function getUser(id, name) {
    if (!db.users[id]) {
        db.users[id] = { name, money: START_MONEY, lastDaily: '', wins: 0, losses: 0, chars: {} };
    }
    const u = db.users[id];
    // 이벤트 배너 천장(pity5/pity4/guaranteed/g4)과 상시 배너 천장(spity5/spity4)은 따로 관리
    for (const k of ['pity5', 'pity4', 'spity5', 'spity4']) if (!u[k]) u[k] = 0;
    if (!u.chars) u.chars = {};
    if (name) u.name = name;
    return u;
}

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = arr => arr[rand(0, arr.length - 1)];
const today = () => new Date().toISOString().slice(0, 10);

// ===== 기원 로직 =====
// banner가 null이면 상시 배너, 아니면 해당 이벤트 배너
function pullOnce(u, banner) {
    const p5 = banner ? 'pity5' : 'spity5';
    const p4 = banner ? 'pity4' : 'spity4';
    u[p5]++;
    u[p4]++;

    let rate5 = 0.006;
    if (u[p5] >= 74) rate5 += (u[p5] - 73) * 0.06;
    if (u[p5] >= 90) rate5 = 1;

    const r = Math.random();
    const give = (name) => { u.chars[name] = (u.chars[name] || 0) + 1; };

    if (r < rate5) {
        u[p5] = 0;
        let name, tag = '';
        if (!banner) {
            name = pick(STANDARD_FIVE);
        } else if (u.guaranteed || Math.random() < 0.5) {
            name = banner.featured5;
            u.guaranteed = false;
            tag = ' (픽업)';
        } else {
            name = pick(STANDARD_FIVE);
            u.guaranteed = true;
            tag = ' (픽업 실패)';
        }
        give(name);
        return { star: 5, name: name + tag };
    }

    if (u[p4] >= 10 || r < rate5 + 0.051) {
        u[p4] = 0;
        let name;
        if (banner && banner.rateup4.length && (u.g4 || Math.random() < 0.5)) {
            name = pick(banner.rateup4);
            u.g4 = false;
        } else {
            name = pick(FOUR_STARS);
            if (banner && banner.rateup4.length && !banner.rateup4.includes(name)) u.g4 = true;
        }
        give(name);
        return { star: 4, name };
    }
    return { star: 3, name: '3성 무기' };
}

function doPulls(message, u, banner, count) {
    const cost = PULL_COST * count;
    if (u.money < cost) return message.reply(`원석이 부족함 (필요: ${cost}, 보유: ${u.money})`);
    u.money -= cost;
    const results = Array.from({ length: count }, () => pullOnce(u, banner));
    save();
    const lines = results.map(r => `${'★'.repeat(r.star)} ${r.name}`);
    const best = Math.max(...results.map(r => r.star));
    const header = best === 5 ? '5성 등장!' : best === 4 ? '4성 등장' : '기원 결과';
    const title = banner ? banner.name : '상시 기원';
    const pity = banner
        ? `천장: ${u.pity5}/90${u.guaranteed ? ' | 다음 5성은 픽업 확정' : ''}`
        : `천장: ${u.spity5}/90`;
    return message.reply(`**${header}** - ${title}\n${lines.join('\n')}\n보유: ${u.money}${CURRENCY} | ${pity}`);
}

// ===== 기타 게임 =====
const guessGames = new Map(); // channelId -> { answer, tries }
const RPS = { 가위: 0, 바위: 1, 보: 2 };
const RPS_NAMES = ['가위', '바위', '보'];

const HELP_TEXT = [
    '**페이몬 게임장 명령어**',
    '`!출석` 하루 한 번 원석 받기',
    '`!지갑` 내 원석과 천장 확인',
    '`!배너` 현재 진행 중인 이벤트 배너 확인',
    '`!기원 [번호]` 이벤트 배너 1회 기원 (160원석, 번호는 !배너 참고)',
    '`!십연 [번호]` 이벤트 배너 10회 기원',
    '`!상시기원`, `!상시십연` 상시 기원',
    '`!캐릭터목록` 전체 캐릭터와 보유 여부',
    '`!보유` 내가 가진 캐릭터',
    '`!주사위 [배팅]` 1~6 중 4 이상이면 승리',
    '`!가위바위보 <가위|바위|보> [배팅]`',
    '`!숫자 시작` / `!숫자 <번호>` 숫자 맞추기',
    '`!나눔 @유저 <금액>` 원석 나눔 (서버 관리자는 무제한)',
    '`!랭킹` 원석 순위',
    '봇을 멘션하거나 DM을 보내면 페이몬과 대화 가능'
].join('\n');

function isAdmin(message) {
    if (!message.guild) return false;
    return message.guild.ownerId === message.author.id
        || !!message.member?.permissions?.has(PermissionFlagsBits.Administrator);
}

function parseBet(arg, u) {
    if (arg === undefined) return { bet: 0 };
    const bet = parseInt(arg, 10);
    if (!Number.isInteger(bet) || bet < 0) return { error: '배팅 금액이 올바르지 않음' };
    if (bet > u.money) return { error: `원석이 부족함 (보유: ${u.money})` };
    return { bet };
}

function pickBanner(message, arg) {
    const list = activeBanners();
    if (!list.length) {
        message.reply('진행 중인 이벤트 배너가 없음. `!상시기원`을 이용하라구!');
        return null;
    }
    const idx = arg === undefined ? 1 : parseInt(arg, 10);
    if (!Number.isInteger(idx) || idx < 1 || idx > list.length) {
        message.reply(`배너 번호가 올바르지 않음 (1~${list.length}). \`!배너\`로 확인하라구!`);
        return null;
    }
    return list[idx - 1];
}

async function handleGame(message) {
    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = args.shift();
    const u = getUser(message.author.id, message.author.username);
    const admin = isAdmin(message);
    u.isAdmin = admin;
    if (admin) u.money = ADMIN_MONEY;

    switch (cmd) {
        case '도움말':
        case '도움':
            return message.reply(HELP_TEXT);

        case '출석': {
            if (u.lastDaily === today()) return message.reply('오늘은 이미 출석했음. 내일 다시 오라구!');
            u.lastDaily = today();
            u.money += DAILY_REWARD;
            save();
            return message.reply(`출석 완료! ${DAILY_REWARD}${CURRENCY} 지급됨. 현재 ${u.money}${CURRENCY}`);
        }

        case '지갑':
        case '잔액':
            return message.reply(
                `${CURRENCY}: ${admin ? '무제한' : u.money}\n` +
                `이벤트 천장: ${u.pity5}/90${u.guaranteed ? ' (다음 5성 픽업 확정)' : ''}\n` +
                `상시 천장: ${u.spity5}/90\n` +
                `전적: ${u.wins}승 ${u.losses}패`
            );

        case '배너': {
            const now = Date.now();
            const list = activeBanners(now);
            const lines = [];
            if (list.length) {
                lines.push('**진행 중인 이벤트 배너**');
                list.forEach((b, i) => {
                    const rate = b.rateup4.length ? `4성 픽업: ${b.rateup4.join(', ')}` : '4성 픽업: 없음';
                    const weapon = b.weapon ? ` / 무기: ${b.weapon}` : '';
                    lines.push(`${i + 1}. ${b.name}\n   5성 픽업: ${b.featured5} / ${rate}${weapon}\n   종료: ${fmtTime(b.end)}`);
                });
                lines.push('`!기원 <번호>`, `!십연 <번호>`로 기원');
            } else {
                lines.push('진행 중인 이벤트 배너가 없음');
            }
            const next = upcomingBanners(now);
            if (next.length) {
                lines.push(`\n**다음 배너**: ${next.map(b => b.featured5).join(', ')} (${fmtTime(next[0].start)} 시작)`);
            }
            lines.push(`\n**상시 기원**: 5성 ${STANDARD_FIVE.join(', ')}\n\`!상시기원\`, \`!상시십연\``);
            return message.reply(lines.join('\n'));
        }

        case '기원':
        case '십연': {
            const banner = pickBanner(message, args[0]);
            if (!banner) return;
            return doPulls(message, u, banner, cmd === '십연' ? 10 : 1);
        }

        case '상시기원':
        case '상시십연':
            return doPulls(message, u, null, cmd === '상시십연' ? 10 : 1);

        case '캐릭터목록':
        case '목록': {
            const fmt = list => list.map(n => (u.chars[n] ? `[보유] ${n}` : n)).join(', ');
            const limited = FIVE_STARS.filter(n => !STANDARD_FIVE.includes(n));
            return message.reply(
                `**5성 상시 (${STANDARD_FIVE.length})**\n${fmt(STANDARD_FIVE)}\n\n` +
                `**5성 한정 (${limited.length})**\n${fmt(limited)}\n\n` +
                `**4성 (${FOUR_STARS.length})**\n${fmt(FOUR_STARS)}`
            );
        }

        case '보유':
        case '인벤': {
            const fmt = list => list.filter(n => u.chars[n]).map(n => (u.chars[n] > 1 ? `${n} x${u.chars[n]}` : n));
            const f = fmt(FIVE_STARS), g = fmt(FOUR_STARS);
            if (!f.length && !g.length) return message.reply('보유한 캐릭터가 없음. `!기원`으로 뽑아보라구!');
            const known = new Set([...FIVE_STARS, ...FOUR_STARS]);
            const etc = Object.keys(u.chars).filter(n => !known.has(n)).map(n => `${n} x${u.chars[n]}`);
            const total = FIVE_STARS.length + FOUR_STARS.length;
            return message.reply(
                `**보유 캐릭터 (${f.length + g.length}/${total})**\n5성: ${f.join(', ') || '없음'}\n4성: ${g.join(', ') || '없음'}` +
                (etc.length ? `\n기타: ${etc.join(', ')}` : '')
            );
        }

        case '주사위': {
            const { bet, error } = parseBet(args[0], u);
            if (error) return message.reply(error);
            const roll = rand(1, 6);
            if (roll >= 4) {
                u.money += bet;
                u.wins++;
                save();
                return message.reply(`주사위: ${roll} 승리! +${bet}${CURRENCY} (보유: ${u.money})`);
            }
            u.money -= bet;
            u.losses++;
            save();
            return message.reply(`주사위: ${roll} 패배... -${bet}${CURRENCY} (보유: ${u.money})`);
        }

        case '가위바위보':
        case '가바보': {
            const pickRps = RPS[args[0]];
            if (pickRps === undefined) return message.reply('사용법: `!가위바위보 <가위|바위|보> [배팅]`');
            const { bet, error } = parseBet(args[1], u);
            if (error) return message.reply(error);
            const bot = rand(0, 2);
            const result = (pickRps - bot + 3) % 3; // 0 무승부, 1 승리, 2 패배
            let text = `나: ${RPS_NAMES[pickRps]} / 페이몬: ${RPS_NAMES[bot]}\n`;
            if (result === 0) {
                text += '무승부!';
            } else if (result === 1) {
                u.money += bet;
                u.wins++;
                text += `승리! +${bet}${CURRENCY}`;
            } else {
                u.money -= bet;
                u.losses++;
                text += `패배! -${bet}${CURRENCY}`;
            }
            save();
            return message.reply(`${text}\n보유: ${u.money}${CURRENCY}`);
        }

        case '숫자': {
            const sub = args[0];
            if (sub === '시작') {
                guessGames.set(message.channel.id, { answer: rand(1, 100), tries: 0 });
                return message.reply('1~100 사이 숫자를 정했음. `!숫자 <번호>`로 맞춰보라구!');
            }
            const game = guessGames.get(message.channel.id);
            if (!game) return message.reply('진행 중인 게임이 없음. `!숫자 시작`으로 시작하라구.');
            const n = parseInt(sub, 10);
            if (!Number.isInteger(n) || n < 1 || n > 100) return message.reply('1~100 사이 숫자를 입력해야 함');
            game.tries++;
            if (n === game.answer) {
                const reward = Math.max(50, 300 - game.tries * 20);
                u.money += reward;
                u.wins++;
                guessGames.delete(message.channel.id);
                save();
                return message.reply(`정답! ${game.tries}번 만에 맞춤. +${reward}${CURRENCY}`);
            }
            return message.reply(n < game.answer ? `${n}보다 큼 (UP)` : `${n}보다 작음 (DOWN)`);
        }

        case '송금':
        case '나눔': {
            const target = message.mentions.users.filter(m => m.id !== client.user.id).first();
            if (!target) return message.reply('받을 사람을 멘션해야해! 예: `!나눔 @유저 3200`');
            if (target.bot) return message.reply('봇에게는 나눔할 수 없음');
            if (target.id === message.author.id) return message.reply('본인에게는 나눔할 수 없음');
            // 멘션을 지우고 남은 글자에서 첫 숫자를 금액으로 읽음 (3200, 3,200, 3200원석 모두 허용)
            const rest = message.content.replace(/<@[!&]?\d+>/g, '').replace(/^!\S+/, '');
            const m = rest.match(/\d[\d,]*/);
            const amount = m ? parseInt(m[0].replace(/,/g, ''), 10) : NaN;
            if (!Number.isInteger(amount) || amount <= 0) return message.reply('금액이 올바르지 않아! 예: `!나눔 @유저 3200`');
            if (!admin && amount > u.money) return message.reply(`원석이 부족해! (보유: ${u.money})`);
            const t = getUser(target.id, target.username);
            if (!admin) u.money -= amount;
            t.money += amount;
            save();
            return message.reply(`${target.username}에게 ${amount}${CURRENCY} 나눔 완료!${admin ? ' (관리자 지급)' : ''}`);
        }

        case '랭킹': {
            const top = Object.values(db.users)
                .filter(x => !x.isAdmin)
                .sort((a, b) => b.money - a.money)
                .slice(0, 10)
                .map((x, i) => `${i + 1}. ${x.name} - ${x.money}${CURRENCY}`);
            return message.reply(top.length ? `**원석 랭킹**\n${top.join('\n')}` : '아직 기록이 없음');
        }

        default:
            return false; // 모르는 명령어는 무시
    }
}

client.once('ready', () => {
    console.log('\n==================================================');
    console.log(`페이몬 봇 구동 성공: ${client.user.tag}`);
    console.log('==================================================\n');
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // 게임 명령어
    if (message.content.startsWith(PREFIX)) {
        try {
            const handled = await handleGame(message);
            if (handled !== false) return;
        } catch (error) {
            console.error('게임 처리 에러:', error);
            return message.reply(`오류가 발생함: \`${error.message}\``);
        }
    }

    console.log(`[감지] 유저: ${message.author.username} | 내용: ${message.content}`);

    const isMentioned = message.mentions.has(client.user);
    const isDM = message.channel.type === ChannelType.DM;

    if (!isMentioned && !isDM) return;

    let userPrompt = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!userPrompt) {
        return message.reply('무슨일이야?');
    }

    try {
        await message.channel.sendTyping();

        const userId = message.author.id;
        if (!conversationHistory.has(userId)) {
            conversationHistory.set(userId, []);
        }

        const userHistory = conversationHistory.get(userId);
        userHistory.push({ role: 'user', content: userPrompt });

        const messagesToSend = [
            { role: 'system', content: CHARACTER_PROMPT },
            ...userHistory
        ];

        console.log('🚀 OpenRouter에 요청 전송 중...');

        let aiResponse = await askAI(messagesToSend);

        // 일부 free 모델이 실수로 안전성 분류 라벨(User Safety: safe 등)을 섞어 보내는 경우 제거
        aiResponse = aiResponse.replace(/^\s*(User|Response) Safety:.*$/gim, '').trim();
        if (!aiResponse) {
            aiResponse = '다시 말해줘!';
        }

        userHistory.push({ role: 'assistant', content: aiResponse });
        if (userHistory.length > MAX_HISTORY) {
            userHistory.splice(0, userHistory.length - MAX_HISTORY);
        }

        await message.reply(aiResponse.slice(0, 2000));
        console.log('✅ 답장 전송 완료!\n');

    } catch (error) {
        console.error('❌ 에러 발생:', error);
        await message.reply(`삐빅 페이몬 고장 삐빅\n오류 내용: \`${error.message}\``);
    }
});

loadDB().then(() => client.login(DISCORD_TOKEN));