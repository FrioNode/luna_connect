---

# 🤖 Luna Bot Session Generator

A **lightweight web service** to generate, manage, and validate **WhatsApp bot sessions** using either **QR code** or **pairing code**.

🌐 **Live Demo:**
👉 [https://lunaconnect.up.railway.app/](https://lunaconnect.up.railway.app/)


####### Backup site (Not always online)

[https://luna.serveousercontent.com/](https://luna.serveousercontent.com/)

---

## ✨ Features

* 🔐 Generate WhatsApp sessions securely
* 📱 Two pairing methods:

  * **QR Code**
  * **Pairing Code**
* 🧾 Auto-generated **session token**
* ⏱️ Session validity checking endpoint
* 🗄️ MongoDB-backed session storage
* 🧑‍💻 Simple web UI + curl support

---

## 🛠️ Environment Setup

Create a `.env` file in the project root with **only one required variable**:

```env
MONGO=mongodb://<username>:<password>@host:port/database
```

🔁 Replace the placeholder with your actual MongoDB connection string.

---

## 🚀 Install & Run

```bash
npm install
npm start
```

The server will start on:

```
http://localhost:8000
```

---

## 🧭 Usage Guide

### 🌐 Web Interface

Open your browser and go to:

👉 **[http://localhost:8000/](http://localhost:8000/)**

You’ll be given **two ways to connect your WhatsApp account**:

1. 🔑 **Pairing Code**
2. 📷 **QR Code**

> ⚠️ Use **only one method** — both generate the same result.

Once paired, you’ll receive a **session token** like:

```text
LUNA~abcdef12345
```

Use this token in your bot’s environment variables:

```env
SESSION=LUNA~abcdef12345
```

---

### ✅ Check Session Status

You can verify whether a session is still valid by visiting:

```
http://localhost:8000/session/LUNA~abcdef12345
```

---

### 🧪 Using curl

#### 🔍 Check session validity

```bash
curl -i http://localhost:8000/session/LUNA~abcdef12345
```

#### 🔗 Pair using phone number (advanced / optional)

> ⚠️ Not recommended for regular use, but useful for testing.

```http
GET http://localhost:8000/pair?number=<international-number-without-plus>
```

Example:

```
http://localhost:8000/pair?number=254712345678
```

---

## 📝 Notes

* ⏳ **Session tokens are valid for 24 hours by default**

  * You can extend this by modifying the MongoDB TTL configuration
* ⚙️ Only the `MONGO` environment variable is required
* 🔒 No sensitive credentials are exposed to the client

---

## 📬 Contact & Community

* 💻 **GitHub:** [https://github.com/frionode](https://github.com/frionode)
* 📢 **Telegram:** [https://t.me/frionode](https://t.me/frionode)
* 🌍 **Socials:**
  Find me everywhere as **[@frionode](https://t.me/frionode)**

---

## 📄 License

🪪 Licensed under the **MIT License**

---