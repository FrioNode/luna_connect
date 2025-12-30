# Luna Bot Session Generator

A minimal service to generate and store WhatsApp pairing sessions and expose a session status endpoint.

---

## Environment

Create a file named `.env` in the project root with the following content (only this variable is required):

```
MONGO=mongodb://<username>:<password>@host:port/database
```

Replace the example with your MongoDB connection string.

## Install & Run

```bash
npm install
npm start
```

## Usage

- Check session status:

  GET http://localhost:8000/session/<session-token>

- Example curl:

  curl -i http://localhost:8000/session/LUNA~abcdef12345

- (Optional) Start pairing by hitting the pairing endpoint:

  GET http://localhost:8000/pair?number=<international-number-without-plus>

## Notes

- Session folders are created using the `session_<number>` pattern; add `session*` to your `.gitignore` to keep credentials out of git.
- You only need to set the `MONGO` env var; no other environment variables are required.

## Contact

GitHub: https://github.com/frionode  (use `frionode` as social handle)

---

Licensed under the MIT License.
