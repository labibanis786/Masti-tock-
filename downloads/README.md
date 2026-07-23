# PingPong — Voice Room App

## চালানোর জন্য
```
npm install
node server.js
```
তারপর:
- Mobile app: `http://localhost:3000/`
- Admin panel: `http://localhost:3000/admin/`  (login: `admin` / `admin123`, বা `ADMIN_USERNAME`/`ADMIN_PASSWORD` env var দিয়ে বদলাও)

আসল ফোনে/একাধিক ডিভাইসে টেস্ট করতে হলে সার্ভার যে মেশিনে চলছে তার লোকাল IP দিয়ে অ্যাক্সেস করো (যেমন `http://192.168.x.x:3000/`), অথবা ngrok/Cloudflare Tunnel ব্যবহার করো যাতে বাইরে থেকেও পৌঁছানো যায়।

## এই প্যাকেজে যা আছে (সব working)
- OTP login, প্রোফাইল, ফলো/ফলোয়ার
- Voice room: 8-সিট, WebRTC peer-to-peer অডিও, real-time mic-level ভিত্তিক speaking-ring (শুধু "বসে থাকা" না, আসলেই কথা বললে জ্বলে)
- Auto ICE-restart reconnect — সিট বদল বা সংক্ষিপ্ত নেটওয়ার্ক ঝাঁকুনিতে রুম থেকে বের না হয়েই ভয়েস আবার জোড়া লাগার চেষ্টা করে
- চ্যাট, গিফট (float animation-সহ), ট্রেজার চেস্ট, ডাইস গেম, মিউজিক, রুম ব্যাকগ্রাউন্ড
- ওয়ালেট (কয়েন/ডায়মন্ড, exchange request), ডেইলি/উইকলি ট্রেজার বক্স
- অ্যাডমিন-পাঠানো PNG ফ্রেম (glow animation-সহ, avatar-এর আকার/ডিজাইন অক্ষত রেখে)
- এজেন্সি সিস্টেম (host assign, commission rate)
- অ্যানাউন্সমেন্ট ব্রডকাস্ট, প্রাইভেট মেসেজ
- সম্পূর্ণ Admin Panel: user ban/verify/coin edit, room lock/delete, exchange approve/reject, frame upload, agency তৈরি, chest level কনফিগ
- পুরো UI Gold + Black + Royal থিমে

## এই সেশনে যা বানানো হয়নি (সৎভাবে জানানো হচ্ছে)
আপনার পাঠানো রেফারেন্স স্ক্রিনশট/ফিচার লিস্টে (Maza/Bigo-স্টাইল) যা ছিল কিন্তু এখানে নেই:
- PK battle system, Family/Guild system, আলাদা Beans currency, Aristocracy tier
- Ludo/UNO/অন্য mini-games, Moments feed, AI ফিচার, একাধিক login পদ্ধতি (Google/Apple/Facebook)
এগুলো প্রতিটাই আলাদা বড় sub-system — লাগলে একটা একটা করে যোগ করা যাবে।

## Production-এর আগে জরুরি
- **TURN সার্ভার**: এখন শুধু ফ্রি Google STUN আছে। যেসব ইউজার strict NAT/corporate network-এ থাকবে তাদের voice কানেক্ট নাও হতে পারে। প্রোডাকশনে একটা TURN সার্ভার (coturn, বা Twilio/Xirsys-এর মতো paid service) লাগবে। অনেক ইউজার একসাথে থাকলে (৮+ জন এক রুমে) mesh P2P-এর বদলে SFU (mediasoup/LiveKit) লাগবে, নাহলে প্রতিটা ইউজারের ডিভাইস N-1 টা আলাদা কানেকশন সামলাতে হবে যেটা ভারী হয়ে যায়।
- **OTP**: এখনো শুধু console-এ প্রিন্ট হয় (dev/Termux setup), আসল SMS পাঠাতে হলে কোনো SMS gateway (Twilio, MSG91 ইত্যাদি) যোগ করতে হবে।
- ADMIN_USERNAME/ADMIN_PASSWORD env var দিয়ে বদলাও, ডিফল্ট রেখো না।

## এই আপডেটে যা ঠিক/যোগ হয়েছে

**কয়েন সিঙ্ক বাগ ফিক্স (গুরুত্বপূর্ণ):** Food Wheel আর Teen Patti গেমে ঢোকার সাথে সাথে কয়েন কমে যাওয়ার বাগ ঠিক হয়েছে — গেমের placeholder default balance (Food Wheel = 0, Teen Patti = 10000) আসল ওয়ালেট balance sync হওয়ার আগেই সার্ভারে পাঠিয়ে দিত। এখন আসল balance না আসা পর্যন্ত গেম কিছু পাঠাবে না। সিঙ্ক স্পিডও 60ms থেকে 20ms-এ কমানো হয়েছে — গেম খেলে বের হলে সাথে সাথে সব জায়গায় সমান কয়েন দেখাবে।

**অন্য দুটো বাগ ফিক্স:**
- REST `/api/gifts/send` এখন recipient আর chest reward winners-দের real-time wallet push করে (আগে শুধু sender-এর নিজের রেসপন্সে balance যেত)
- ভিডিও/কাস্টম গিফট এখন রুমের Treasure Chest progress-এ কাউন্ট হয় (আগে কয়েন কাটতো কিন্তু চেস্টে যোগ হতো না)

**Coin Center — একসাথে একাধিক ইউজারকে পাঠানো:** Admin Panel → Coin Center-এ "একসাথে একাধিক ইউজারকে পাঠাও" টগল অন করলে একাধিক ইউজার সার্চ করে লিস্টে যোগ করা যাবে, তারপর একই amount + reason দিয়ে একবারে সবাইকে পাঠানো যাবে। প্রতিটা recipient-এর জন্য আলাদা audit log entry হয়, এবং system balance প্রতিটা পাঠানোর সাথে সাথেই কমে (একজনের জন্য balance অপর্যাপ্ত হলে শুধু সেই একজনই বাদ পড়বে, বাকিরা ঠিকই পাবে)।

## PingPong AI Core (নতুন)
`ai/` ফোল্ডারে একটা আলাদা, modular AI backend যোগ হয়েছে — কোনো existing feature (wallet, gifts, rooms, login, SVIP, Coin Center ইত্যাদি) স্পর্শ করেনি।

**সেটআপ:**
1. `npm install` চালাও (নতুন `dotenv` dependency যোগ হয়েছে)।
2. `.env` ফাইলে `GEMINI_API_KEY` বসাও (`.env.example` দেখো)। `.env` আগে থেকেই `.gitignore`-এ আছে, GitHub-এ যাবে না।
3. সার্ভার রিস্টার্ট করলেই PingPong Help অ্যাক্টিভ হয়ে যাবে।
4. Provider বদলাতে হলে: `ai/providers/` এ নতুন ফাইল বানাও, `.env`-এ `AI_PROVIDER` বদলাও — বাকি কোডে পরিবর্তন লাগবে না।

**যা কাজ করছে:**
- PingPong Help — প্রতিটা ইউজারের Private Messages-এ সবসময় দেখাবে, প্রথমবার খুললে welcome message, বাংলা/ইংরেজি/হিন্দিতে স্বাভাবিক কথোপকথন, session-based memory
- Server monitoring, rate-limiting + spam detection, analytics + activity log — সব Admin Panel → AI Core ট্যাবে
- সব financial logic সম্পূর্ণ সার্ভার-সাইড; AI কখনো wallet টাচ করে না

**যা বানানো যায়নি / বাস্তবসম্মত না:**
- Root/Emulator/Play Integrity/Modified-APK detection — Android/Flutter native কোডে বসাতে হয়
- সত্যিকারের auto-restart — PM2 বা হোস্টিং প্রোভাইডারের process manager লাগবে
- এই স্যান্ডবক্সে ইন্টারনেট অ্যাক্সেস নেই তাই Gemini API আসলে কল হয়ে সাড়া দিচ্ছে কিনা লাইভ টেস্ট করা যায়নি
- ⚠️ `.env`-এ বসানো key-এর ফরম্যাট Gemini key-এর মতো লাগছে না (বিস্তারিত `.env`-এর কমেন্টে) — টেস্ট করার আগে যাচাই করে নাও
