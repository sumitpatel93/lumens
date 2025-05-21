// upload.js - Handles CSV processing and database operations
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { parse } = require('csv-parse');
const { program } = require('commander');
const setupDatabase = require('./setup-db');

// Parse command line arguments when running as a standalone script
program
  .option('-f, --file <path>', 'Path to CSV file')
  .option('-b, --batch-size <size>', 'Batch size for processing rows', '1000')
  .option('--truncate', 'Truncate existing data before import')
  .option('--create-schema', 'Create schema if it doesn\'t exist')
  .option('--force-schema', 'Force recreate schema even if tables exist')
  .option('--interval <time>', 'Set refresh interval (e.g. 1min, 30min, 1h, 1d)') 
  .option('--mode <mode>', 'Set refresh mode (overwrite or append)', 'append')
  .parse(process.argv);

const options = program.opts();

// Create a connection pool that can be reused
const createPool = () => {
  return new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'postgres',
    password: process.env.DB_PASSWORD || 'yourpassword',
    port: process.env.DB_PORT || 5432,
  });
};

// Global pool for CLI usage
const pool = createPool();

// Parse interval string to milliseconds
function parseInterval(intervalStr) {
  if (!intervalStr) return null;
  
  const match = intervalStr.match(/^(\d+)(min|h|d|s)$/);
  if (!match) {
    console.error('Invalid interval format. Use format like 1min, 30min, 1h, 1d, 10s');
    return null;
  }
  
  const value = parseInt(match[1]);
  const unit = match[2];
  
  switch (unit) {
    case 's': return value * 1000;
    case 'min': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

// CLI-specific variables
const intervalMs = options.interval ? parseInterval(options.interval) : null;
const isOverwriteMode = options.mode === 'overwrite' || options.truncate;

// Environment setup based on options
if (options.forceSchema) {
  process.env.FORCE_SCHEMA_SETUP = 'true';
}

// Verify schema exists and create if needed
async function verifySchema(customPool = pool, createIfMissing = false) {
  console.log('\n==== SCHEMA VERIFICATION ====');
  const client = await customPool.connect();
  
  try {
    // Check if all required tables exist
    const requiredTables = [
      'customers', 'regions', 'categories', 'payment_methods',
      'products', 'orders', 'order_items', 'data_refresh_logs'
    ];
    
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = ANY($1)
    `, [requiredTables]);
    
    const existingTables = result.rows.map(row => row.table_name);
    const missingTables = requiredTables.filter(table => !existingTables.includes(table));
    
    if (missingTables.length > 0) {
      console.log(`Missing tables detected: ${missingTables.join(', ')}`);
      
      if (createIfMissing) {
        console.log('Creating/updating schema as requested...');
        client.release();
        
        // Use the separate schema setup script
        const schemaSetupSuccess = await setupDatabase();
        if (!schemaSetupSuccess) {
          console.error('Failed to set up schema');
          return false;
        }
        return true;
      } else {
        console.error(`Schema is incomplete. Missing tables: ${missingTables.join(', ')}`);
        return false;
      }
    }
    
    console.log('✓ All required tables exist in the database');
    return true;
  } catch (error) {
    console.error('Error verifying schema:', error.message);
    return false;
  } finally {
    client.release();
  }
}

// Truncate all data if requested
async function truncateData(customPool = pool) {
  console.log('\n==== TRUNCATING EXISTING DATA ====');
  const client = await customPool.connect();
  try {
    await client.query('BEGIN');
    
    // Disable foreign key constraints temporarily
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    
    // Truncate tables in reverse order of dependencies
    console.log('Truncating table: order_items');
    await client.query('TRUNCATE TABLE order_items CASCADE');
    
    console.log('Truncating table: orders');
    await client.query('TRUNCATE TABLE orders CASCADE');
    
    console.log('Truncating table: products');
    await client.query('TRUNCATE TABLE products CASCADE');
    
    console.log('Truncating table: customers');
    await client.query('TRUNCATE TABLE customers CASCADE');
    
    console.log('Truncating table: payment_methods');
    await client.query('TRUNCATE TABLE payment_methods CASCADE');
    
    console.log('Truncating table: categories');
    await client.query('TRUNCATE TABLE categories CASCADE');
    
    console.log('Truncating table: regions');
    await client.query('TRUNCATE TABLE regions CASCADE');
    
    await client.query('COMMIT');
    console.log('✓ All existing data truncated successfully');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error truncating data:', error.message);
    return false;
  } finally {
    client.release();
  }
}

// Main function to process CSV file
async function processCSV(filePath, batchSize, customPool = pool) {
  console.log(`\n==== PROCESSING CSV FILE: ${path.basename(filePath)} ====`);
  console.log(`Batch size: ${batchSize} rows`);
  
  const startTime = new Date();
  console.log(`Start time: ${startTime.toISOString()}`);
  
  let logId = null;
  
  // Create log entry
  try {
    const logResult = await customPool.query(
      'INSERT INTO data_refresh_logs(filename, rows_processed, status, start_time, end_time) VALUES($1, $2, $3, $4, $5) RETURNING id',
      [path.basename(filePath), 0, 'processing', startTime, startTime]
    );
    logId = logResult.rows[0].id;
    console.log(`Created log entry with ID: ${logId}`);
  } catch (error) {
    console.log('Warning: Could not create log entry. Continuing with import.');
  }
  
  // Process the CSV file
  return new Promise((resolve, reject) => {
    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
    
    let batch = [];
    let totalRowsProcessed = 0;
    let batchCount = 0;
    
    // Track unique values for lookup tables
    const regions = new Map();
    const categories = new Map();
    const paymentMethods = new Map();
    
    // Maps to track processed IDs
    const processedCustomers = new Set();
    const processedProducts = new Set();
    const processedOrders = new Set();
    
    // Data for batch inserts
    const customers = [];
    const products = [];
    const orders = [];
    const orderItems = [];
    
    console.log('Starting CSV parsing...');
    
    // Process each row from CSV
    parser.on('readable', async function() {
      let record;
      
      while ((record = parser.read()) !== null) {
        batch.push(record);
        
        // Add region to map if new
        if (!regions.has(record.Region)) {
          regions.set(record.Region, null); // Will be replaced with ID after insert
        }
        
        // Add category to map if new
        if (!categories.has(record.Category)) {
          categories.set(record.Category, null);
        }
        
        // Add payment method to map if new
        if (!paymentMethods.has(record['Payment Method'])) {
          paymentMethods.set(record['Payment Method'], null);
        }
        
        // Add customer if not processed yet
        if (!processedCustomers.has(record['Customer ID'])) {
          customers.push({
            id: record['Customer ID'],
            name: record['Customer Name'],
            email: record['Customer Email'],
            address: record['Customer Address']
          });
          processedCustomers.add(record['Customer ID']);
        }
        
        // Add product if not processed yet
        if (!processedProducts.has(record['Product ID'])) {
          products.push({
            id: record['Product ID'],
            name: record['Product Name'],
            category: record.Category
          });
          processedProducts.add(record['Product ID']);
        }
        
        // If batch size reached, process the batch
        if (batch.length >= batchSize) {
          parser.pause();
          try {
            batchCount++;
            console.log(`\nProcessing batch #${batchCount}...`);
            
            await processBatch(
              batch, regions, categories, paymentMethods, 
              customers, products, orders, orderItems, 
              processedOrders,
              customPool
            );
            
            totalRowsProcessed += batch.length;
            console.log(`✓ Batch #${batchCount} complete - ${batch.length} rows processed`);
            console.log(`Total rows processed so far: ${totalRowsProcessed}`);
            
            // Reset batch data
            batch = [];
            customers.length = 0;
            products.length = 0;
            orders.length = 0;
            orderItems.length = 0;
            
            parser.resume();
          } catch (error) {
            console.error(`ERROR PROCESSING BATCH #${batchCount}:`, error.message);
            reject(error);
          }
        }
      }
    });
    
    // Handle the end of file
    parser.on('end', async function() {
      try {
        if (batch.length > 0) {
          batchCount++;
          console.log(`\nProcessing final batch #${batchCount}...`);
          
          await processBatch(
            batch, regions, categories, paymentMethods, 
            customers, products, orders, orderItems, 
            processedOrders,
            customPool
          );
          
          totalRowsProcessed += batch.length;
          console.log(`✓ Final batch #${batchCount} complete - ${batch.length} rows processed`);
        }
        
        const endTime = new Date();
        const duration = (endTime - startTime) / 1000;
        
        console.log(`\n==== CSV PROCESSING COMPLETE ====`);
        console.log(`Total rows processed: ${totalRowsProcessed}`);
        console.log(`Start time: ${startTime.toISOString()}`);
        console.log(`End time: ${endTime.toISOString()}`);
        console.log(`Duration: ${duration} seconds`);
        console.log(`Processing rate: ${Math.round(totalRowsProcessed / duration)} rows per second`);
        
        // Update log entry
        if (logId) {
          await customPool.query(
            'UPDATE data_refresh_logs SET rows_processed = $1, status = $2, end_time = $3 WHERE id = $4',
            [totalRowsProcessed, 'success', endTime, logId]
          );
          console.log(`✓ Updated log entry (ID: ${logId}) with success status`);
        }
        
        resolve({ totalRows: totalRowsProcessed, startTime, endTime, duration });
      } catch (error) {
        // Update log entry with error
        if (logId) {
          const endTime = new Date();
          await customPool.query(
            'UPDATE data_refresh_logs SET status = $1, end_time = $2, error_message = $3 WHERE id = $4',
            ['failed', endTime, error.message, logId]
          );
          console.log(`✓ Updated log entry (ID: ${logId}) with failure status`);
        }
        
        console.error('\n CSV PROCESSING FAILED:');
        console.error(error);
        reject(error);
      }
    });
    
    // Handle errors
    parser.on('error', function(error) {
      console.error('\n CSV PARSING ERROR:');
      console.error(error);
      reject(error);
    });
    
    // Start reading the file
    fs.createReadStream(filePath).pipe(parser);
  });
}

// Process a batch of CSV records
async function processBatch(
  batch, regions, categories, paymentMethods, 
  customers, products, orders, orderItems, 
  processedOrders,
  customPool = pool
) {
  const client = await customPool.connect();
  
  try {
    await client.query('BEGIN');
    console.log('Transaction started');
    
    // Insert regions and get IDs
    if (regions.size > 0) {
      console.log(`Processing ${regions.size} unique regions`);
      const regionNames = [...regions.keys()];
      for (const name of regionNames) {
        if (regions.get(name) === null) { // Only process if ID not already fetched
          const result = await client.query(
            'INSERT INTO regions(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name = $1 RETURNING id',
            [name]
          );
          regions.set(name, result.rows[0].id);
        }
      }
    }
    
    // Insert categories and get IDs
    if (categories.size > 0) {
      console.log(`Processing ${categories.size} unique categories`);
      const categoryNames = [...categories.keys()];
      for (const name of categoryNames) {
        if (categories.get(name) === null) { // Only process if ID not already fetched
          const result = await client.query(
            'INSERT INTO categories(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name = $1 RETURNING id',
            [name]
          );
          categories.set(name, result.rows[0].id);
        }
      }
    }
    
    // Insert payment methods and get IDs
    if (paymentMethods.size > 0) {
      console.log(`Processing ${paymentMethods.size} unique payment methods`);
      const paymentMethodNames = [...paymentMethods.keys()];
      for (const name of paymentMethodNames) {
        if (paymentMethods.get(name) === null) { // Only process if ID not already fetched
          const result = await client.query(
            'INSERT INTO payment_methods(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name = $1 RETURNING id',
            [name]
          );
          paymentMethods.set(name, result.rows[0].id);
        }
      }
    }
    
    // Insert customers
    if (customers.length > 0) {
      console.log(`Processing ${customers.length} unique customers`);
      for (const customer of customers) {
        await client.query(
          'INSERT INTO customers(customer_id, name, email, address) VALUES($1, $2, $3, $4) ON CONFLICT(customer_id) DO UPDATE SET name = $2, email = $3, address = $4',
          [customer.id, customer.name, customer.email, customer.address]
        );
      }
    }
    
    // Insert products
    if (products.length > 0) {
      console.log(`Processing ${products.length} unique products`);
      for (const product of products) {
        const categoryId = categories.get(product.category);
        await client.query(
          'INSERT INTO products(product_id, name, category_id) VALUES($1, $2, $3) ON CONFLICT(product_id) DO UPDATE SET name = $2, category_id = $3',
          [product.id, product.name, categoryId]
        );
      }
    }
    
    // Process orders and order items
    let orderCount = 0;
    let orderItemCount = 0;
    
    // First pass to build orders list
    for (const row of batch) {
      if (!processedOrders.has(row['Order ID'])) {
        orderCount++;
        orders.push({
          id: row['Order ID'],
          customerId: row['Customer ID'],
          regionName: row.Region,
          paymentMethodName: row['Payment Method'],
          orderDate: row['Date of Sale'],
          shippingCost: row['Shipping Cost']
        });
        processedOrders.add(row['Order ID']);
      }
      
      // Build order items list
      orderItemCount++;
      orderItems.push({
        orderId: row['Order ID'],
        productId: row['Product ID'],
        quantity: row['Quantity Sold'],
        unitPrice: row['Unit Price'],
        discount: row['Discount']
      });
    }
    
    // Insert orders
    if (orders.length > 0) {
      console.log(`Processing ${orders.length} unique orders`);
      for (const order of orders) {
        const regionId = regions.get(order.regionName);
        const paymentMethodId = paymentMethods.get(order.paymentMethodName);
        
        await client.query(
          'INSERT INTO orders(order_id, customer_id, region_id, payment_method_id, order_date, shipping_cost) VALUES($1, $2, $3, $4, $5, $6) ON CONFLICT(order_id) DO UPDATE SET customer_id = $2, region_id = $3, payment_method_id = $4, order_date = $5, shipping_cost = $6',
          [
            order.id,
            order.customerId,
            regionId,
            paymentMethodId,
            new Date(order.orderDate),
            parseFloat(order.shippingCost)
          ]
        );
      }
    }
    
    // Insert order items
    if (orderItems.length > 0) {
      console.log(`Processing ${orderItems.length} order items`);
      
      // First delete existing items for these orders to prevent duplicates
      const orderIds = [...new Set(orderItems.map(item => item.orderId))];
      await client.query(
        'DELETE FROM order_items WHERE order_id = ANY($1)',
        [orderIds]
      );
      
      // Then insert new items
      for (const item of orderItems) {
        await client.query(
          'INSERT INTO order_items(order_id, product_id, quantity, unit_price, discount) VALUES($1, $2, $3, $4, $5)',
          [
            item.orderId,
            item.productId,
            parseInt(item.quantity),
            parseFloat(item.unitPrice),
            parseFloat(item.discount)
          ]
        );
      }
    }
    
    await client.query('COMMIT');
    console.log('Transaction committed successfully');
    console.log(`Summary: ${orderCount} orders and ${orderItemCount} order items processed`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Transaction rolled back due to error');
    throw error;
  } finally {
    client.release();
  }
}

// Core function for uploading CSV data
async function uploadData(filePath, options = {}) {
  // Create a new pool for this operation
  const uploadPool = createPool();
  
  try {
    const {
      batchSize = 1000,
      createSchema = true,
      truncate = false,
    } = options;
    
    console.log('\n======== SALES DATA UPLOAD TOOL ========');
    console.log(`File: ${filePath}`);
    console.log(`Batch size: ${batchSize}`);
    console.log(`Truncate data: ${truncate ? 'Yes' : 'No'}`);
    console.log(`Create schema: ${createSchema ? 'Yes' : 'No'}`);
    
    // Verify and create schema if needed
    if (createSchema) {
      const schemaValid = await verifySchema(uploadPool, createSchema);
      if (!schemaValid) {
        throw new Error('Schema verification failed');
      }
    }
    
    // Truncate data if requested
    if (truncate) {
      const truncateSuccess = await truncateData(uploadPool);
      if (!truncateSuccess) {
        throw new Error('Data truncation failed');
      }
    }
    
    // Process CSV file
    const result = await processCSV(filePath, parseInt(batchSize), uploadPool);
    
    console.log('\n======== UPLOAD COMPLETED SUCCESSFULLY ========');
    console.log(`CSV File: ${path.basename(filePath)}`);
    console.log(`Total rows: ${result.totalRows}`);
    console.log(`Processing time: ${result.duration} seconds`);
    console.log(`Average speed: ${Math.round(result.totalRows / result.duration)} rows/second`);
    console.log('================================================\n');
    
    return {
      success: true,
      totalRows: result.totalRows,
      duration: result.duration,
      filename: path.basename(filePath)
    };
  } catch (error) {
    console.error('\n======== UPLOAD FAILED ========');
    console.error('Error:', error.message);
    console.error('===================================\n');
    throw error;
  } finally {
    // Always close the pool after the operation completes
    await uploadPool.end();
  }
}

// CLI-specific function to run the upload process
async function runUpload() {
  try {
    // Validate file path (CLI-specific check)
    if (!options.file) {
      console.error('Error: CSV file path is required. Use --file or -f option.');
      return false;
    }

    if (!fs.existsSync(options.file)) {
      console.error(`Error: File not found: ${options.file}`);
      return false;
    }
    
    console.log('\n======== SALES DATA UPLOAD TOOL ========');
    console.log(`File: ${options.file}`);
    console.log(`Batch size: ${options.batchSize}`);
    console.log(`Refresh mode: ${isOverwriteMode ? 'Overwrite' : 'Append'}`);
    console.log(`Create schema: ${options.createSchema ? 'Yes' : 'No'}`);
    console.log(`Force schema: ${options.forceSchema ? 'Yes' : 'No'}`);
    console.log(`Time: ${new Date().toISOString()}`);
    
    // Verify and create schema if needed
    const schemaValid = await verifySchema(pool, options.createSchema);
    if (!schemaValid) {
      console.error('Schema verification failed. Skipping this execution.');
      return false;
    }
    
    // Truncate data if in overwrite mode
    if (isOverwriteMode) {
      const truncateSuccess = await truncateData(pool);
      if (!truncateSuccess) {
        console.error('Data truncation failed. Skipping this execution.');
        return false;
      }
    }
    
    // Process CSV file
    const result = await processCSV(options.file, parseInt(options.batchSize), pool);
    
    console.log('\n======== UPLOAD COMPLETED SUCCESSFULLY ========');
    console.log(`CSV File: ${path.basename(options.file)}`);
    console.log(`Total rows: ${result.totalRows}`);
    console.log(`Processing time: ${result.duration} seconds`);
    console.log(`Average speed: ${Math.round(result.totalRows / result.duration)} rows/second`);
    console.log('================================================\n');
    
    return true;
  } catch (error) {
    console.error('\n======== UPLOAD FAILED ========');
    console.error('Error:', error.message);
    console.error('===================================\n');
    return false;
  }
}

// Main execution with interval support for CLI
async function main() {
  // CLI-specific validation
  if (!options.file) {
    console.error('Error: CSV file path is required. Use --file or -f option.');
    process.exit(1);
  }

  if (!fs.existsSync(options.file)) {
    console.error(`Error: File not found: ${options.file}`);
    process.exit(1);
  }
  
  if (intervalMs) {
    console.log(`Setting up periodic refresh every ${options.interval}`);
    console.log(`Refresh mode: ${isOverwriteMode ? 'Overwrite' : 'Append'}`);
    
    // Run once immediately
    await runUpload();
    
    // Then set up interval
    const intervalId = setInterval(async () => {
      try {
        console.log(`\n\n[${new Date().toISOString()}] Running scheduled refresh...`);
        await runUpload();
      } catch (error) {
        console.error('Unhandled error in periodic execution:', error);
      }
    }, intervalMs);
    
    // Keep process running
    console.log('Periodic refresh started. Press Ctrl+C to stop.');
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down periodic refresh...');
      clearInterval(intervalId);
      await pool.end();
      console.log('Database connection closed.');
      process.exit(0);
    });
  } else {
    // One-time run
    await runUpload();
    // Close DB connection and exit
    await pool.end();
  }
}

// Export for API usage
module.exports = {
  createPool,
  verifySchema,
  truncateData,
  processCSV,
  processBatch,
  uploadData
};

// Run if called directly from CLI
if (require.main === module) {
  main();
}