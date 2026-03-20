# AI Agent Manager Backend

Backend สำหรับ AI Agent Manager สำหรับ SME ไทย

## Environment Variables

```bash
# Server
PORT=3000

# LINE Bot SDK
LINE_CHANNEL_ACCESS_TOKEN=your_line_channel_access_token
LINE_CHANNEL_SECRET=your_line_channel_secret

# AI Integration (Choose one)
OPENAI_API_KEY=your_openai_api_key
# or
ANTHROPIC_API_KEY=your_anthropic_api_key

# Database (Optional - defaults to ./data/database.sqlite)
DATABASE_PATH=./data/database.sqlite
```

## Setup Instructions

### 1. Install Dependencies
```bash
cd backend
npm install
```

### 2. Configure Environment
```bash
cp config.env.example .env
# Then edit .env with your actual values
```

### 3. Get LINE Credentials
1. Go to [LINE Developers Console](https://developers.line.biz/)
2. Create a new Provider
3. Create a Messaging API Channel
4. Get Channel Access Token and Channel Secret
5. Set Webhook URL: `https://your-domain.com/webhook`

### 4. Run the Server
```bash
# Development
npm run dev

# Production
npm start
```

## API Endpoints

### Dashboard
- `GET /api/dashboard` - Get dashboard statistics

### Orders
- `GET /api/orders` - Get all orders (supports ?status=pending&limit=100)
- `GET /api/orders/:id` - Get single order
- `PATCH /api/orders/:id/status` - Update order status

### Products
- `GET /api/products` - Get all active products

### Users
- `GET /api/users/:lineId` - Get user by LINE ID

### LINE Webhook
- `POST /webhook` - LINE webhook endpoint

### Health Check
- `GET /health` - Server health check

## Database Schema

### orders
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| lineId | TEXT | LINE user ID |
| product | TEXT | Product name |
| quantity | INTEGER | Order quantity |
| price | REAL | Unit price |
| details | TEXT | Order details |
| status | TEXT | pending/completed/cancelled |
| createdAt | DATETIME | Creation timestamp |

### users
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| lineId | TEXT | LINE user ID (unique) |
| displayName | TEXT | Display name |
| pictureUrl | TEXT | Profile picture URL |
| status | TEXT | User status |
| createdAt | DATETIME | Creation timestamp |

### products
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| name | TEXT | Product name |
| description | TEXT | Product description |
| price | REAL | Unit price |
| stock | INTEGER | Stock quantity |
| imageUrl | TEXT | Product image URL |
| status | TEXT | active/inactive |
| createdAt | DATETIME | Creation timestamp |

## Tech Stack
- Node.js + Express
- SQLite (better-sqlite3)
- @line/bot-sdk
- OpenAI API (optional)
