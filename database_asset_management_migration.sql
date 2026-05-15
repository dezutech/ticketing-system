-- ============================================
-- ASSET MANAGEMENT MODULE - SQL SERVER MIGRATION
-- Run this after database_setup.sql
-- ============================================

USE TicketingDB;
GO

-- ============================================
-- ASSET CATEGORIES TABLE
-- ============================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'asset_categories')
BEGIN
    CREATE TABLE asset_categories (
        category_id INT PRIMARY KEY IDENTITY(1,1),
        category_name NVARCHAR(100) NOT NULL UNIQUE,
        description NVARCHAR(255),
        is_active BIT DEFAULT 1,
        created_at DATETIME DEFAULT GETDATE(),
        updated_at DATETIME DEFAULT GETDATE()
    );

    INSERT INTO asset_categories (category_name, description)
    VALUES
        ('Laptop', 'Portable computers assigned to employees'),
        ('Desktop', 'Desktop computers and workstations'),
        ('Monitor', 'External displays and monitors'),
        ('Printer', 'Printers, scanners, and multifunction devices'),
        ('Network Equipment', 'Routers, switches, access points, and related devices'),
        ('Mobile Device', 'Phones, tablets, and handheld devices'),
        ('Peripheral', 'Keyboards, mice, headsets, webcams, and accessories');
END
GO

-- ============================================
-- ASSETS TABLE
-- ============================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'assets')
BEGIN
    CREATE TABLE assets (
        asset_id INT PRIMARY KEY IDENTITY(1,1),
        asset_tag NVARCHAR(50) NOT NULL UNIQUE,
        asset_name NVARCHAR(150) NOT NULL,
        category_id INT,
        brand NVARCHAR(100),
        model NVARCHAR(100),
        serial_number NVARCHAR(100),
        status NVARCHAR(30) NOT NULL DEFAULT 'Available'
            CHECK (status IN ('Available', 'Assigned', 'Under Repair', 'Retired', 'Lost')),
        assigned_to INT,
        department NVARCHAR(100),
        location NVARCHAR(150),
        purchase_date DATE,
        warranty_expiry DATE,
        supplier NVARCHAR(150),
        notes NVARCHAR(MAX),
        created_at DATETIME DEFAULT GETDATE(),
        updated_at DATETIME DEFAULT GETDATE(),
        FOREIGN KEY (category_id) REFERENCES asset_categories(category_id),
        FOREIGN KEY (assigned_to) REFERENCES Users(user_id)
    );

    CREATE INDEX IX_assets_status ON assets(status);
    CREATE INDEX IX_assets_category_id ON assets(category_id);
    CREATE INDEX IX_assets_assigned_to ON assets(assigned_to);
    CREATE INDEX IX_assets_department ON assets(department);
END
GO

-- ============================================
-- ASSET ASSIGNMENTS TABLE
-- ============================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'asset_assignments')
BEGIN
    CREATE TABLE asset_assignments (
        assignment_id INT PRIMARY KEY IDENTITY(1,1),
        asset_id INT NOT NULL,
        assigned_to INT NOT NULL,
        assigned_by INT,
        department NVARCHAR(100),
        location NVARCHAR(150),
        assigned_at DATETIME DEFAULT GETDATE(),
        returned_at DATETIME,
        return_condition NVARCHAR(255),
        notes NVARCHAR(MAX),
        created_at DATETIME DEFAULT GETDATE(),
        updated_at DATETIME DEFAULT GETDATE(),
        FOREIGN KEY (asset_id) REFERENCES assets(asset_id) ON DELETE CASCADE,
        FOREIGN KEY (assigned_to) REFERENCES Users(user_id),
        FOREIGN KEY (assigned_by) REFERENCES Users(user_id)
    );

    CREATE INDEX IX_asset_assignments_asset_id ON asset_assignments(asset_id);
    CREATE INDEX IX_asset_assignments_assigned_to ON asset_assignments(assigned_to);
    CREATE INDEX IX_asset_assignments_returned_at ON asset_assignments(returned_at);
END
GO

-- ============================================
-- ASSET MAINTENANCE LOGS TABLE
-- ============================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'asset_maintenance_logs')
BEGIN
    CREATE TABLE asset_maintenance_logs (
        maintenance_id INT PRIMARY KEY IDENTITY(1,1),
        asset_id INT NOT NULL,
        maintenance_type NVARCHAR(100),
        description NVARCHAR(MAX) NOT NULL,
        performed_by INT,
        vendor NVARCHAR(150),
        cost DECIMAL(18,2),
        maintenance_date DATETIME DEFAULT GETDATE(),
        next_maintenance_date DATETIME,
        status NVARCHAR(30) DEFAULT 'Completed'
            CHECK (status IN ('Scheduled', 'In Progress', 'Completed', 'Cancelled')),
        notes NVARCHAR(MAX),
        created_at DATETIME DEFAULT GETDATE(),
        updated_at DATETIME DEFAULT GETDATE(),
        FOREIGN KEY (asset_id) REFERENCES assets(asset_id) ON DELETE CASCADE,
        FOREIGN KEY (performed_by) REFERENCES Users(user_id)
    );

    CREATE INDEX IX_asset_maintenance_logs_asset_id ON asset_maintenance_logs(asset_id);
    CREATE INDEX IX_asset_maintenance_logs_maintenance_date ON asset_maintenance_logs(maintenance_date);
    CREATE INDEX IX_asset_maintenance_logs_status ON asset_maintenance_logs(status);
END
GO

-- ============================================
-- ASSET ACTIVITY LOGS TABLE
-- ============================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'asset_activity_logs')
BEGIN
    CREATE TABLE asset_activity_logs (
        log_id INT PRIMARY KEY IDENTITY(1,1),
        asset_id INT NOT NULL,
        action NVARCHAR(100) NOT NULL,
        old_value NVARCHAR(MAX),
        new_value NVARCHAR(MAX),
        changed_by INT,
        created_at DATETIME DEFAULT GETDATE(),
        FOREIGN KEY (asset_id) REFERENCES assets(asset_id) ON DELETE CASCADE,
        FOREIGN KEY (changed_by) REFERENCES Users(user_id)
    );

    CREATE INDEX IX_asset_activity_logs_asset_id ON asset_activity_logs(asset_id);
    CREATE INDEX IX_asset_activity_logs_action ON asset_activity_logs(action);
    CREATE INDEX IX_asset_activity_logs_created_at ON asset_activity_logs(created_at);
END
GO

-- ============================================
-- TICKET ASSETS LINK TABLE
-- ============================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ticket_assets')
BEGIN
    CREATE TABLE ticket_assets (
        ticket_asset_id INT PRIMARY KEY IDENTITY(1,1),
        ticket_id INT NOT NULL,
        asset_id INT NOT NULL,
        linked_by INT,
        linked_at DATETIME DEFAULT GETDATE(),
        FOREIGN KEY (ticket_id) REFERENCES Tickets(ticket_id) ON DELETE CASCADE,
        FOREIGN KEY (asset_id) REFERENCES assets(asset_id),
        FOREIGN KEY (linked_by) REFERENCES Users(user_id),
        CONSTRAINT UQ_ticket_assets_ticket_id UNIQUE (ticket_id)
    );

    CREATE INDEX IX_ticket_assets_asset_id ON ticket_assets(asset_id);
END
GO

PRINT 'Asset Management migration complete!';
