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
