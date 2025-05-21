# Sales Analytics API

A RESTful API for analyzing sales data from CSV files. This backend solution processes sales data, stores it in a normalized PostgreSQL database, and provides endpoints for revenue analysis.

## Features

- **CSV Upload**: Upload and process CSV files with sales data
- **Normalized Database Schema**: Optimized PostgreSQL schema design
- **Data Refresh**: On-demand and scheduled data refresh capabilities
- **RESTful API**: Endpoints for revenue analysis and data management
- **Revenue Analysis**: Calculate revenue metrics by date range, product, category, region and time trends

## Project Structure

```
sales-analytics-api/
├── src/
│   ├── schema.sql              # Database schema definition
│   ├── setup-db.js             # Database setup script
│   ├── upload.js               # CSV processing script
│   ├── server.js               # Express API server
│   └── uploads/                # Directory for uploaded CSV files
├── .env                        # Environment variables
├── .gitignore                  # Git ignore file
├── package.json                # Node.js dependencies
└── README.md                   # Project documentation
```

## Prerequisites

- Node.js (v14 or higher)
- PostgreSQL (v12 or higher)
- npm or yarn

## Installation

1. **Clone the repository**

```bash
git clone https://github.com/sumitpatel93/lumens.git
cd lumens
```

2. **Install dependencies**

```bash
npm install
```

3. **Set up environment variables**

Create a `.env` file in the project root:

```
# Database connection
DB_USER=postgres
DB_HOST=localhost
DB_NAME=sales_analytics
DB_PASSWORD=yourpassword
DB_PORT=5432

# Server settings
PORT=3000
```

4. **Create the database**

```bash
createdb sales_analytics
```

5. **Initialize database schema**

```bash
node src/setup-db.js
```

## Usage

### Starting the API Server

```bash
node src/server.js
```

For development with auto-reload:

```bash
npm install -g nodemon
nodemon src/server.js
```

### Data Processing Options

#### Process a CSV file directly (CLI)

```bash
node src/upload.js --file path/to/your/data.csv --create-schema
```

#### Set up scheduled data refresh

```bash
# Refresh data every hour
node src/upload.js --file path/to/your/data.csv --interval 1h

# Refresh data daily, overwriting existing data
node src/upload.js --file path/to/your/data.csv --interval 1d --mode overwrite
```

Available interval units:
- `s`: seconds (e.g., `30s`)
- `min`: minutes (e.g., `15min`)
- `h`: hours (e.g., `1h`)
- `d`: days (e.g., `1d`)

## API Endpoints

| Route | Method | Description | Parameters |
|-------|--------|-------------|------------|
| `/api/health` | GET | Health check endpoint | None |
| `/api/data/upload` | POST | Upload CSV file and refresh data | `file`: CSV file (form-data)<br>`mode`: 'append' or 'overwrite' |
| `/api/data/refresh` | POST | Trigger data refresh | `mode`: 'append' or 'overwrite' |
| `/api/data/history` | GET | Get history of data refreshes | `limit`, `offset` |
| `/api/analysis/revenue/total` | GET | Calculate total revenue | `startDate`, `endDate` |
| `/api/analysis/revenue/by-product` | GET | Calculate revenue by product | `startDate`, `endDate`, `limit`, `offset` |
| `/api/analysis/revenue/by-category` | GET | Calculate revenue by category | `startDate`, `endDate` |
| `/api/analysis/revenue/by-region` | GET | Calculate revenue by region | `startDate`, `endDate` |
| `/api/analysis/revenue/trends` | GET | Calculate revenue trends | `startDate`, `endDate`, `interval` |

## API Examples

### Health Check

```bash
curl http://localhost:3000/api/health
```

### Upload CSV File

```bash
curl -X POST http://localhost:3000/api/data/upload \
  -F "file=@path/to/sales_data.csv" \
  -F "mode=append"
```

### Refresh Data

```bash
curl -X POST http://localhost:3000/api/data/refresh \
  -H "Content-Type: application/json" \
  -d '{"mode": "overwrite"}'
```

### Get Total Revenue

```bash
curl "http://localhost:3000/api/analysis/revenue/total?startDate=2023-01-01&endDate=2023-12-31"
```

### Get Revenue by Product

```bash
curl "http://localhost:3000/api/analysis/revenue/by-product?startDate=2023-01-01&endDate=2023-12-31&limit=10&offset=0"
```

### Get Revenue by Category

```bash
curl "http://localhost:3000/api/analysis/revenue/by-category?startDate=2023-01-01&endDate=2023-12-31"
```

### Get Revenue by Region

```bash
curl "http://localhost:3000/api/analysis/revenue/by-region?startDate=2023-01-01&endDate=2023-12-31"
```

### Get Revenue Trends

```bash
curl "http://localhost:3000/api/analysis/revenue/trends?startDate=2023-01-01&endDate=2023-12-31&interval=monthly"
```

Valid intervals: `daily`, `weekly`, `monthly`, `quarterly`, `yearly`

## Sample CSV Format

The API expects CSV files with the following header structure:

```
Order ID,Product ID,Customer ID,Product Name,Category,Region,Date of Sale,Quantity Sold,Unit Price,Discount,Shipping Cost,Payment Method,Customer Name,Customer Email,Customer Address
```

Example row:
```
1001,P123,C456,UltraBoost Running Shoes,Shoes,North America,2023-12-15,2,180.00,0.1,10.00,Credit Card,John Smith,johnsmith@email.com,"123 Main St, Anytown, CA 12345"
```

## Database Schema

The system uses a normalized database schema with the following tables:

- `customers`: Customer information
- `products`: Product details
- `categories`: Product categories
- `regions`: Sales regions
- `payment_methods`: Payment method types
- `orders`: Order header information
- `order_items`: Order line items
- `data_refresh_logs`: History of data refresh operations

## Error Handling

The API includes robust error handling for:

- Invalid request parameters
- Database connection issues
- File upload problems
- CSV parsing errors
- Data integrity violations

All errors return appropriate HTTP status codes with descriptive error messages.

## Performance Considerations

- CSV processing is done in batches to handle large files efficiently
- Database operations use prepared statements for security and performance
- Indexes are created on commonly queried columns
- The normalized schema reduces data redundancy
- Transactions ensure data consistency

## License

This project is licensed under the MIT License.