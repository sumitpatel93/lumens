// server.js - RESTful API for Sales Data Analysis
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { body, query, validationResult } = require('express-validator');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');
const multer = require('multer');

// Create Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev')); // Logging middleware

// Configure multer for file uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function(req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: function(req, file, cb) {
    if (file.mimetype !== 'text/csv') {
      return cb(new Error('Only CSV files are allowed'));
    }
    cb(null, true);
  }
});

// Database connection
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'postgres',
  password: process.env.DB_PASSWORD || 'yourpassword',
  port: process.env.DB_PORT || 5432,
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection error:', err.message);
  } else {
    console.log('Connected to database successfully');
  }
});

// Validation error handler middleware
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      success: false, 
      errors: errors.array().map(err => ({
        field: err.path,
        message: err.msg
      }))
    });
  }
  next();
};

// ==========================================
// API ROUTES
// ==========================================

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date(),
    uptime: process.uptime()
  });
});

// 1. API ENDPOINTS FOR DATA REFRESH

// Trigger data refresh with existing file (on-demand refresh)
app.post('/api/data/refresh', [
  body('mode').optional().isIn(['append', 'overwrite']).withMessage('Mode must be either "append" or "overwrite"'),
  handleValidationErrors
], async (req, res) => {
  try {
    // Get the refresh mode (append or overwrite)
    const mode = req.body.mode || 'append';
    const truncate = mode === 'overwrite';
    
    // Find the most recent CSV file
    const files = fs.readdirSync(uploadDir);
    
    if (files.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No CSV files found. Please upload a file first.'
      });
    }
    
    // Sort by creation time (most recent first)
    const mostRecentFile = files
      .map(file => ({ name: file, time: fs.statSync(path.join(uploadDir, file)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time)[0].name;
    
    const filePath = path.join(uploadDir, mostRecentFile);
    
    // Run the upload script as a child process
    const uploadProcess = spawn('node', [
      './upload.js',
      '--file', filePath,
      '--create-schema',
      ...(truncate ? ['--truncate'] : [])
    ]);
    
    let output = '';
    let errorOutput = '';
    
    uploadProcess.stdout.on('data', (data) => {
      output += data.toString();
      console.log(`Upload process: ${data}`);
    });
    
    uploadProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
      console.error(`Upload process error: ${data}`);
    });
    
    uploadProcess.on('close', (code) => {
      if (code === 0) {
        // Success
        res.status(200).json({
          success: true,
          message: 'Data refresh completed successfully',
          mode: mode,
          file: mostRecentFile
        });
      } else {
        // Error
        res.status(500).json({
          success: false,
          message: 'Data refresh failed',
          error: errorOutput || 'Unknown error',
          exitCode: code
        });
      }
    });
  } catch (error) {
    console.error('Error triggering data refresh:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to trigger data refresh',
      error: error.message
    });
  }
});

// Upload new CSV file and refresh data
app.post('/api/data/upload', upload.single('file'), [
  body('mode').optional().isIn(['append', 'overwrite']).withMessage('Mode must be either "append" or "overwrite"'),
  handleValidationErrors
], async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }
    
    const mode = req.body.mode || 'append';
    const truncate = mode === 'overwrite';
    const filePath = req.file.path;
    
    // Run the upload script as a child process
    const uploadProcess = spawn('node', [
      './upload.js',
      '--file', filePath,
      '--create-schema',
      ...(truncate ? ['--truncate'] : [])
    ]);
    
    let output = '';
    let errorOutput = '';
    
    uploadProcess.stdout.on('data', (data) => {
      output += data.toString();
      console.log(`Upload process: ${data}`);
    });
    
    uploadProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
      console.error(`Upload process error: ${data}`);
    });
    
    uploadProcess.on('close', (code) => {
      if (code === 0) {
        // Success
        res.status(200).json({
          success: true,
          message: 'File uploaded and data refresh completed successfully',
          mode: mode,
          file: {
            originalName: req.file.originalname,
            size: req.file.size,
            path: req.file.path
          }
        });
      } else {
        // Error
        res.status(500).json({
          success: false,
          message: 'File upload succeeded but data refresh failed',
          error: errorOutput || 'Unknown error',
          exitCode: code
        });
      }
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload file',
      error: error.message
    });
  }
});

// Get data refresh history
app.get('/api/data/history', async (req, res) => {
  try {
    const { limit = 10, offset = 0 } = req.query;
    
    const result = await pool.query(
      `SELECT * FROM data_refresh_logs
       ORDER BY start_time DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    
    res.status(200).json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching data refresh history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch data refresh history',
      error: error.message
    });
  }
});

// 2. API ENDPOINTS FOR REVENUE ANALYSIS

// Validation for date range params
const dateRangeValidation = [
  query('startDate')
    .isDate()
    .withMessage('Start date must be in YYYY-MM-DD format'),
  query('endDate')
    .isDate()
    .withMessage('End date must be in YYYY-MM-DD format')
    .custom((value, { req }) => {
      if (new Date(value) < new Date(req.query.startDate)) {
        throw new Error('End date must be after or equal to start date');
      }
      return true;
    }),
  handleValidationErrors
];

// Calculate total revenue for a date range
app.get('/api/analysis/revenue/total', dateRangeValidation, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const result = await pool.query(
      `SELECT SUM((oi.unit_price * oi.quantity) * (1 - oi.discount)) AS total_revenue
       FROM orders o
       JOIN order_items oi ON o.order_id = oi.order_id
       WHERE o.order_date BETWEEN $1 AND $2`,
      [startDate, endDate]
    );
    
    res.status(200).json({
      success: true,
      data: {
        startDate,
        endDate,
        totalRevenue: parseFloat(result.rows[0].total_revenue) || 0
      }
    });
  } catch (error) {
    console.error('Error calculating total revenue:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to calculate total revenue',
      error: error.message
    });
  }
});

// Calculate revenue by product for a date range
app.get('/api/analysis/revenue/by-product', dateRangeValidation, async (req, res) => {
  try {
    const { startDate, endDate, limit = 100, offset = 0 } = req.query;
    
    const result = await pool.query(
      `SELECT 
         p.product_id,
         p.name AS product_name,
         SUM((oi.unit_price * oi.quantity) * (1 - oi.discount)) AS revenue
       FROM orders o
       JOIN order_items oi ON o.order_id = oi.order_id
       JOIN products p ON oi.product_id = p.product_id
       WHERE o.order_date BETWEEN $1 AND $2
       GROUP BY p.product_id, p.name
       ORDER BY revenue DESC
       LIMIT $3 OFFSET $4`,
      [startDate, endDate, limit, offset]
    );
    
    // Get the total count for pagination
    const countResult = await pool.query(
      `SELECT COUNT(DISTINCT p.product_id) AS total_count
       FROM orders o
       JOIN order_items oi ON o.order_id = oi.order_id
       JOIN products p ON oi.product_id = p.product_id
       WHERE o.order_date BETWEEN $1 AND $2`,
      [startDate, endDate]
    );
    
    const totalProducts = parseInt(countResult.rows[0].total_count);
    
    res.status(200).json({
      success: true,
      data: {
        startDate,
        endDate,
        pagination: {
          totalProducts,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: parseInt(offset) + parseInt(limit) < totalProducts
        },
        products: result.rows.map(row => ({
          productId: row.product_id,
          productName: row.product_name,
          revenue: parseFloat(row.revenue)
        }))
      }
    });
  } catch (error) {
    console.error('Error calculating revenue by product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to calculate revenue by product',
      error: error.message
    });
  }
});

// Calculate revenue by category for a date range
app.get('/api/analysis/revenue/by-category', dateRangeValidation, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const result = await pool.query(
      `SELECT 
         c.name AS category_name,
         SUM((oi.unit_price * oi.quantity) * (1 - oi.discount)) AS revenue
       FROM orders o
       JOIN order_items oi ON o.order_id = oi.order_id
       JOIN products p ON oi.product_id = p.product_id
       JOIN categories c ON p.category_id = c.id
       WHERE o.order_date BETWEEN $1 AND $2
       GROUP BY c.name
       ORDER BY revenue DESC`,
      [startDate, endDate]
    );
    
    res.status(200).json({
      success: true,
      data: {
        startDate,
        endDate,
        categories: result.rows.map(row => ({
          category: row.category_name,
          revenue: parseFloat(row.revenue)
        }))
      }
    });
  } catch (error) {
    console.error('Error calculating revenue by category:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to calculate revenue by category',
      error: error.message
    });
  }
});

// Calculate revenue by region for a date range
app.get('/api/analysis/revenue/by-region', dateRangeValidation, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const result = await pool.query(
      `SELECT 
         r.name AS region_name,
         SUM((oi.unit_price * oi.quantity) * (1 - oi.discount)) AS revenue
       FROM orders o
       JOIN order_items oi ON o.order_id = oi.order_id
       JOIN regions r ON o.region_id = r.id
       WHERE o.order_date BETWEEN $1 AND $2
       GROUP BY r.name
       ORDER BY revenue DESC`,
      [startDate, endDate]
    );
    
    res.status(200).json({
      success: true,
      data: {
        startDate,
        endDate,
        regions: result.rows.map(row => ({
          region: row.region_name,
          revenue: parseFloat(row.revenue)
        }))
      }
    });
  } catch (error) {
    console.error('Error calculating revenue by region:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to calculate revenue by region',
      error: error.message
    });
  }
});

// Calculate revenue trends over time for a date range
app.get('/api/analysis/revenue/trends', [
  ...dateRangeValidation,
  query('interval')
    .optional()
    .isIn(['daily', 'weekly', 'monthly', 'quarterly', 'yearly'])
    .withMessage('Interval must be one of: daily, weekly, monthly, quarterly, yearly'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { startDate, endDate, interval = 'monthly' } = req.query;
    
    let timeFormat, groupByFormat;
    
    switch (interval) {
      case 'daily':
        timeFormat = 'YYYY-MM-DD';
        groupByFormat = 'date_trunc(\'day\', o.order_date)';
        break;
      case 'weekly':
        timeFormat = 'IYYY-IW'; // ISO year and week
        groupByFormat = 'date_trunc(\'week\', o.order_date)';
        break;
      case 'monthly':
        timeFormat = 'YYYY-MM';
        groupByFormat = 'date_trunc(\'month\', o.order_date)';
        break;
      case 'quarterly':
        timeFormat = 'YYYY-"Q"Q';
        groupByFormat = 'date_trunc(\'quarter\', o.order_date)';
        break;
      case 'yearly':
        timeFormat = 'YYYY';
        groupByFormat = 'date_trunc(\'year\', o.order_date)';
        break;
      default:
        timeFormat = 'YYYY-MM';
        groupByFormat = 'date_trunc(\'month\', o.order_date)';
    }
    
    const result = await pool.query(
      `SELECT 
         TO_CHAR(${groupByFormat}, '${timeFormat}') AS time_period,
         ${groupByFormat} AS date_value,
         SUM((oi.unit_price * oi.quantity) * (1 - oi.discount)) AS revenue
       FROM orders o
       JOIN order_items oi ON o.order_id = oi.order_id
       WHERE o.order_date BETWEEN $1 AND $2
       GROUP BY date_value, time_period
       ORDER BY date_value`,
      [startDate, endDate]
    );
    
    res.status(200).json({
      success: true,
      data: {
        startDate,
        endDate,
        interval,
        trends: result.rows.map(row => ({
          period: row.time_period,
          revenue: parseFloat(row.revenue)
        }))
      }
    });
  } catch (error) {
    console.error('Error calculating revenue trends:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to calculate revenue trends',
      error: error.message
    });
  }
});

// Error handler middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: err.message
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API available at http://localhost:${PORT}/api`);
});