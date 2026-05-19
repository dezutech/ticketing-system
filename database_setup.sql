-- ============================================
-- TICKETING SYSTEM - SQL SERVER SETUP SCRIPT
-- Run this once to create all tables
-- ============================================

-- Create Database
IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = 'TicketingDB')
BEGIN
    CREATE DATABASE TicketingDB;
END
GO

USE TicketingDB;
GO

-- ============================================
-- ROLES TABLE
-- ============================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Roles')
BEGIN
    CREATE TABLE Roles (
        role_id INT PRIMARY KEY IDENTITY(1,1),
        role_name NVARCHAR(50) NOT NULL UNIQUE,
        description NVARCHAR(255),
        can_assign_tickets BIT DEFAULT 0,
        can_manage_users BIT DEFAULT 0,
        can_view_all_tickets BIT DEFAULT 0,
        can_manage_roles BIT DEFAULT 0,
        is_active BIT DEFAULT 1,
        created_at DATETIME DEFAULT GETDATE()
    );

    -- Insert default roles
    INSERT INTO Roles (role_name, description, can_assign_tickets, can_manage_users, can_view_all_tickets, can_manage_roles)
    VALUES 
        ('Super Admin', 'Full system access, can manage everything', 1, 1, 1, 1),
        ('Admin', 'Can manage tickets and users', 1, 1, 1, 0),
        ('Staff', 'Can handle assigned tickets', 0, 0, 0, 0),
        ('User', 'Can create and view own tickets', 0, 0, 0, 0);
END
GO

-- ============================================
-- USERS TABLE
-- ============================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Users')
BEGIN
    CREATE TABLE Users (
        user_id INT PRIMARY KEY IDENTITY(1,1),
        username NVARCHAR(50) NOT NULL UNIQUE,
        email NVARCHAR(100) NOT NULL UNIQUE,
        password_hash NVARCHAR(255) NOT NULL,
        full_name NVARCHAR(100) NOT NULL,
        role_id INT NOT NULL DEFAULT 4,
        department NVARCHAR(100),
        is_active BIT DEFAULT 1,
        created_at DATETIME DEFAULT GETDATE(),
        updated_at DATETIME DEFAULT GETDATE(),
        last_login DATETIME,
        FOREIGN KEY (role_id) REFERENCES Roles(role_id)
    );

    -- Default super admin (password: Admin@123 - CHANGE THIS!)
    -- bcrypt hash for 'Admin@123'
    INSERT INTO Users (username, email, password_hash, full_name, role_id, department)
    VALUES ('superadmin', 'superadmin@company.com', '$2a$10$urExMb1MTcojLGBbG/YUWO4TnUN5PfrQ9finfFi5h37jMI0t/unFy', 'Super Administrator', 1, 'IT');
END
GO

-- ============================================
-- CATEGORIES TABLE
-- ============================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Categories')
BEGIN
    CREATE TABLE Categories (
        category_id INT PRIMARY KEY IDENTITY(1,1),
        category_name NVARCHAR(100) NOT NULL,
        description NVARCHAR(255),
        is_active BIT DEFAULT 1,
        created_at DATETIME DEFAULT GETDATE()
    );

    INSERT INTO Categories (category_name, description)
    VALUES 
        ('Technical Issue', 'Hardware, software, network problems'),
        ('HR Concern', 'Leave, benefits, personnel matters'),
        ('Facilities', 'Office maintenance and utilities'),
        ('Finance', 'Billing, reimbursements, budget'),
        ('General Inquiry', 'Other requests and questions');
END
GO

-- ============================================
-- TICKETS TABLE
-- ============================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Tickets')
BEGIN
    CREATE TABLE Tickets (
        ticket_id INT PRIMARY KEY IDENTITY(1,1),
        ticket_number NVARCHAR(20) NOT NULL UNIQUE,
        title NVARCHAR(255) NOT NULL,
        description NVARCHAR(MAX) NOT NULL,
        category_id INT,
        priority NVARCHAR(20) DEFAULT 'Normal' CHECK (priority IN ('Urgent', 'High', 'Normal', 'Low')),
        status NVARCHAR(20) DEFAULT 'Open' CHECK (status IN ('Open', 'In Progress', 'Pending', 'Resolved', 'Closed')),
        created_by INT NOT NULL,
        assigned_to INT,
        department NVARCHAR(100),
        resolution_notes NVARCHAR(MAX),
        created_at DATETIME DEFAULT GETDATE(),
        updated_at DATETIME DEFAULT GETDATE(),
        acknowledged_at DATETIME,
        resolved_at DATETIME,
        due_date DATETIME,
        FOREIGN KEY (category_id) REFERENCES Categories(category_id),
        FOREIGN KEY (created_by) REFERENCES Users(user_id),
        FOREIGN KEY (assigned_to) REFERENCES Users(user_id)
    );
END
GO

-- ============================================
-- TICKET ATTACHMENTS TABLE
-- ============================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'TicketAttachments')
BEGIN
    CREATE TABLE TicketAttachments (
        attachment_id INT PRIMARY KEY IDENTITY(1,1),
        ticket_id INT NOT NULL,
        file_name NVARCHAR(255) NOT NULL,
        original_name NVARCHAR(255) NOT NULL,
        file_type NVARCHAR(100),
        file_size BIGINT,
        file_path NVARCHAR(500) NOT NULL,
        uploaded_by INT NOT NULL,
        uploaded_at DATETIME DEFAULT GETDATE(),
        FOREIGN KEY (ticket_id) REFERENCES Tickets(ticket_id) ON DELETE CASCADE,
        FOREIGN KEY (uploaded_by) REFERENCES Users(user_id)
    );
END
GO

-- ============================================
-- TICKET COMMENTS TABLE
-- ============================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'TicketComments')
BEGIN
    CREATE TABLE TicketComments (
        comment_id INT PRIMARY KEY IDENTITY(1,1),
        ticket_id INT NOT NULL,
        user_id INT NOT NULL,
        comment NVARCHAR(MAX) NOT NULL,
        is_internal BIT DEFAULT 0,
        created_at DATETIME DEFAULT GETDATE(),
        FOREIGN KEY (ticket_id) REFERENCES Tickets(ticket_id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES Users(user_id)
    );
END
GO

-- ============================================
-- TICKET HISTORY / AUDIT LOG TABLE
-- ============================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'TicketHistory')
BEGIN
    CREATE TABLE TicketHistory (
        history_id INT PRIMARY KEY IDENTITY(1,1),
        ticket_id INT NOT NULL,
        changed_by INT NOT NULL,
        field_changed NVARCHAR(100),
        old_value NVARCHAR(500),
        new_value NVARCHAR(500),
        changed_at DATETIME DEFAULT GETDATE(),
        FOREIGN KEY (ticket_id) REFERENCES Tickets(ticket_id) ON DELETE CASCADE,
        FOREIGN KEY (changed_by) REFERENCES Users(user_id)
    );
END
GO

-- ============================================
-- STORED PROCEDURE: Generate Ticket Number
-- ============================================
IF OBJECT_ID('dbo.GenerateTicketNumber', 'P') IS NOT NULL
    DROP PROCEDURE dbo.GenerateTicketNumber;
GO

CREATE PROCEDURE GenerateTicketNumber
AS
BEGIN
    DECLARE @year NVARCHAR(4) = CAST(YEAR(GETDATE()) AS NVARCHAR(4));
    DECLARE @count INT;
    SELECT @count = COUNT(*) + 1 FROM Tickets WHERE YEAR(created_at) = YEAR(GETDATE());
    RETURN CONCAT('TKT-', @year, '-', FORMAT(@count, '0000'));
END
GO

-- ============================================
-- VIEW: Ticket Dashboard Summary
-- ============================================
IF OBJECT_ID('dbo.vw_TicketSummary', 'V') IS NOT NULL
    DROP VIEW dbo.vw_TicketSummary;
GO

CREATE VIEW vw_TicketSummary AS
SELECT 
    t.ticket_id,
    t.ticket_number,
    t.title,
    t.priority,
    t.status,
    t.created_at,
    t.updated_at,
    t.acknowledged_at,
    t.resolved_at,
    CASE WHEN t.acknowledged_at IS NOT NULL THEN DATEDIFF(MINUTE, t.created_at, t.acknowledged_at) END AS time_to_acknowledge_minutes,
    CASE WHEN t.resolved_at IS NOT NULL THEN DATEDIFF(MINUTE, t.created_at, t.resolved_at) END AS time_to_resolve_minutes,
    c.category_name,
    creator.full_name AS created_by_name,
    creator.email AS created_by_email,
    assignee.full_name AS assigned_to_name,
    assignee.email AS assigned_to_email,
    t.department,
    t.due_date,
    (SELECT COUNT(*) FROM TicketAttachments ta WHERE ta.ticket_id = t.ticket_id) AS attachment_count,
    (SELECT COUNT(*) FROM TicketComments tc WHERE tc.ticket_id = t.ticket_id) AS comment_count
FROM Tickets t
LEFT JOIN Categories c ON t.category_id = c.category_id
LEFT JOIN Users creator ON t.created_by = creator.user_id
LEFT JOIN Users assignee ON t.assigned_to = assignee.user_id;
GO

PRINT 'Database setup complete! Default login: superadmin / Admin@123';
PRINT 'IMPORTANT: Change the default password after first login!';

-- ============================================
-- MIGRATION: Add new columns to Users table
-- ============================================
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'phone')
    ALTER TABLE Users ADD phone NVARCHAR(30);

IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'position')
    ALTER TABLE Users ADD position NVARCHAR(100);

IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'branch')
    ALTER TABLE Users ADD branch NVARCHAR(100);

IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'must_change_password')
    ALTER TABLE Users ADD must_change_password BIT DEFAULT 0;
GO

IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'theme_preference')
    ALTER TABLE Users ADD theme_preference NVARCHAR(20) NOT NULL CONSTRAINT DF_Users_theme_preference DEFAULT 'modern';
GO

IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'night_mode_enabled')
    ALTER TABLE Users ADD night_mode_enabled BIT NOT NULL CONSTRAINT DF_Users_night_mode_enabled DEFAULT 0;
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ActivityLogs')
BEGIN
    CREATE TABLE ActivityLogs (
        log_id INT PRIMARY KEY IDENTITY(1,1),
        user_id INT NULL,
        user_name NVARCHAR(150) NOT NULL,
        user_role NVARCHAR(80) NOT NULL,
        action NVARCHAR(120) NOT NULL,
        module NVARCHAR(80) NOT NULL,
        record_id NVARCHAR(80) NULL,
        details NVARCHAR(MAX) NULL,
        created_at DATETIME NOT NULL DEFAULT GETDATE(),
        FOREIGN KEY (user_id) REFERENCES Users(user_id)
    );
    CREATE INDEX IX_ActivityLogs_created_at ON ActivityLogs(created_at DESC);
    CREATE INDEX IX_ActivityLogs_module ON ActivityLogs(module);
    CREATE INDEX IX_ActivityLogs_action ON ActivityLogs(action);
END
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Notifications')
BEGIN
    CREATE TABLE Notifications (
        notification_id INT PRIMARY KEY IDENTITY(1,1),
        user_id INT NOT NULL,
        title NVARCHAR(150) NULL,
        message NVARCHAR(255) NOT NULL,
        type NVARCHAR(50) NULL,
        module NVARCHAR(50) NOT NULL,
        record_id INT NULL,
        related_ticket_id INT NULL,
        related_asset_id INT NULL,
        link_target NVARCHAR(120) NULL,
        is_read BIT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT GETDATE(),
        FOREIGN KEY (user_id) REFERENCES Users(user_id)
    );
    CREATE INDEX IX_Notifications_user_read ON Notifications(user_id, is_read, created_at DESC);
END
GO

-- ============================================
-- DEPARTMENTS TABLE
-- ============================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Departments')
BEGIN
    CREATE TABLE Departments (
        department_id INT PRIMARY KEY IDENTITY(1,1),
        department_name NVARCHAR(100) NOT NULL UNIQUE,
        description NVARCHAR(255),
        is_active BIT DEFAULT 1,
        created_at DATETIME DEFAULT GETDATE()
    );

    INSERT INTO Departments (department_name, description)
    VALUES
        ('IT', 'Information Technology'),
        ('HR', 'Human Resources'),
        ('Finance', 'Finance and Accounting'),
        ('Operations', 'Operations Department'),
        ('Admin', 'Administration');
END
GO

PRINT 'Migration complete!';
