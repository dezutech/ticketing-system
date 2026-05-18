-- ============================================
-- HELPDESK + ASSET MANAGEMENT DEMO DATA SEED
-- Safe insert-only sample data for SQL Server
-- Password for all demo users: Admin@123
-- Uses existing bcrypt hash from the app setup.
--
-- Populates:
-- Roles reference variables, Departments, ticket Categories, asset_categories,
-- Users, assets, asset_assignments, asset_maintenance_logs, Tickets,
-- ticket_assets, TicketComments, TicketHistory, asset_activity_logs,
-- ActivityLogs, and Notifications.
--
-- Notes:
-- - This script does not delete existing data.
-- - Asset status "Borrowed" is not in the current assets CHECK constraint.
--   Borrowed scenarios are represented through assignment notes and
--   asset_activity_logs using valid current statuses.
-- ============================================

USE TicketingDB;
GO

SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    DECLARE @PasswordHash NVARCHAR(255) = '$2a$10$urExMb1MTcojLGBbG/YUWO4TnUN5PfrQ9finfFi5h37jMI0t/unFy';
    DECLARE @Now DATETIME = GETDATE();

    -- Departments
    INSERT INTO Departments (department_name, description, is_active)
    SELECT v.department_name, v.description, 1
    FROM (VALUES
        ('IT', 'Information Technology and HelpDesk Operations'),
        ('HR', 'Human Resources'),
        ('Finance', 'Finance Planning and Treasury'),
        ('Operations', 'Branch and Field Operations'),
        ('Accounting', 'Accounting and Payables'),
        ('Sales', 'Sales and Account Management'),
        ('Warehouse', 'Warehouse and Inventory Control'),
        ('Admin Office', 'Administration and Office Services')
    ) v(department_name, description)
    WHERE NOT EXISTS (SELECT 1 FROM Departments d WHERE d.department_name = v.department_name);

    -- Ticket categories
    INSERT INTO Categories (category_name, description, is_active)
    SELECT v.category_name, v.description, 1
    FROM (VALUES
        ('Hardware Issue', 'Laptop, desktop, printer, monitor, and device issues'),
        ('Software Issue', 'Application, operating system, and licensing issues'),
        ('Network Issue', 'Wi-Fi, LAN, VPN, router, and switch connectivity'),
        ('Account Access', 'Login, password, email, ERP, and permission requests'),
        ('Asset Request', 'Requests for IT equipment and peripherals'),
        ('General Inquiry', 'General HelpDesk inquiries and support coordination')
    ) v(category_name, description)
    WHERE NOT EXISTS (SELECT 1 FROM Categories c WHERE c.category_name = v.category_name);

    -- Asset categories
    INSERT INTO asset_categories (category_name, description, is_active)
    SELECT v.category_name, v.description, 1
    FROM (VALUES
        ('Laptop', 'Portable business laptops'),
        ('Desktop', 'Office desktop workstations'),
        ('Printer', 'Printers and multifunction devices'),
        ('Monitor', 'External displays'),
        ('CCTV', 'Security cameras and recorders'),
        ('Router', 'Internet routers and gateway devices'),
        ('Switch', 'Network switches'),
        ('POS', 'Point-of-sale terminals'),
        ('UPS', 'Uninterruptible power supplies'),
        ('Mobile Device', 'Phones and tablets')
    ) v(category_name, description)
    WHERE NOT EXISTS (SELECT 1 FROM asset_categories ac WHERE ac.category_name = v.category_name);

    DECLARE @SuperAdminRole INT = (SELECT role_id FROM Roles WHERE role_name = 'Super Admin');
    DECLARE @AdminRole INT = (SELECT role_id FROM Roles WHERE role_name = 'Admin');
    DECLARE @StaffRole INT = (SELECT role_id FROM Roles WHERE role_name = 'Staff');
    DECLARE @UserRole INT = (SELECT role_id FROM Roles WHERE role_name = 'User');

    -- Users: 1 Super Admin, 2 Admins, 5 Staff, 15 Users
    INSERT INTO Users (username, email, password_hash, full_name, role_id, department, phone, position, branch, must_change_password, theme_preference, is_active, created_at, updated_at)
    SELECT v.username, v.email, @PasswordHash, v.full_name, v.role_id, v.department, v.phone, v.position, v.branch, 0, 'modern', 1, DATEADD(day, -v.age_days, @Now), DATEADD(day, -v.age_days + 1, @Now)
    FROM (VALUES
        ('demo.superadmin', 'marco.reyes@northwindph.test', 'Marco Antonio Reyes', @SuperAdminRole, 'IT', '+63 917 555 0101', 'IT Director', 'Head Office - Makati', 330),
        ('demo.admin1', 'ana.santos@northwindph.test', 'Ana Patricia Santos', @AdminRole, 'IT', '+63 917 555 0102', 'IT Service Manager', 'Head Office - Makati', 320),
        ('demo.admin2', 'jose.villanueva@northwindph.test', 'Jose Miguel Villanueva', @AdminRole, 'Admin Office', '+63 917 555 0103', 'Systems Administrator', 'Cebu Branch', 300),
        ('demo.staff1', 'kristine.delacruz@northwindph.test', 'Kristine Dela Cruz', @StaffRole, 'IT', '+63 917 555 0104', 'HelpDesk Specialist', 'Head Office - Makati', 260),
        ('demo.staff2', 'paolo.garcia@northwindph.test', 'Paolo Garcia', @StaffRole, 'IT', '+63 917 555 0105', 'Field Support Engineer', 'Cebu Branch', 250),
        ('demo.staff3', 'bea.ramos@northwindph.test', 'Bea Ramos', @StaffRole, 'IT', '+63 917 555 0106', 'Network Technician', 'Davao Branch', 240),
        ('demo.staff4', 'ronald.mendoza@northwindph.test', 'Ronald Mendoza', @StaffRole, 'IT', '+63 917 555 0107', 'Asset Custodian', 'Laguna Warehouse', 230),
        ('demo.staff5', 'mika.lim@northwindph.test', 'Mikaela Lim', @StaffRole, 'IT', '+63 917 555 0108', 'Application Support Analyst', 'Head Office - Makati', 225),
        ('demo.user1', 'carla.bautista@northwindph.test', 'Carla Bautista', @UserRole, 'Finance', '+63 917 555 0201', 'Finance Analyst', 'Head Office - Makati', 210),
        ('demo.user2', 'miguel.torres@northwindph.test', 'Miguel Torres', @UserRole, 'Operations', '+63 917 555 0202', 'Operations Supervisor', 'Cebu Branch', 205),
        ('demo.user3', 'lianne.cruz@northwindph.test', 'Lianne Cruz', @UserRole, 'HR', '+63 917 555 0203', 'HR Associate', 'Head Office - Makati', 200),
        ('demo.user4', 'nathaniel.chua@northwindph.test', 'Nathaniel Chua', @UserRole, 'Sales', '+63 917 555 0204', 'Account Executive', 'Davao Branch', 195),
        ('demo.user5', 'angelica.navarro@northwindph.test', 'Angelica Navarro', @UserRole, 'Accounting', '+63 917 555 0205', 'Accounting Officer', 'Head Office - Makati', 190),
        ('demo.user6', 'jerome.aquino@northwindph.test', 'Jerome Aquino', @UserRole, 'Warehouse', '+63 917 555 0206', 'Inventory Controller', 'Laguna Warehouse', 185),
        ('demo.user7', 'marielle.flores@northwindph.test', 'Marielle Flores', @UserRole, 'Admin Office', '+63 917 555 0207', 'Admin Assistant', 'Cebu Branch', 180),
        ('demo.user8', 'vince.santiago@northwindph.test', 'Vince Santiago', @UserRole, 'Operations', '+63 917 555 0208', 'Branch Coordinator', 'Davao Branch', 175),
        ('demo.user9', 'trisha.robles@northwindph.test', 'Trisha Robles', @UserRole, 'Sales', '+63 917 555 0209', 'Sales Coordinator', 'Head Office - Makati', 170),
        ('demo.user10', 'aldrin.castillo@northwindph.test', 'Aldrin Castillo', @UserRole, 'Finance', '+63 917 555 0210', 'Treasury Assistant', 'Head Office - Makati', 165),
        ('demo.user11', 'janelle.morales@northwindph.test', 'Janelle Morales', @UserRole, 'HR', '+63 917 555 0211', 'Recruitment Specialist', 'Cebu Branch', 160),
        ('demo.user12', 'eric.valdez@northwindph.test', 'Eric Valdez', @UserRole, 'Warehouse', '+63 917 555 0212', 'Warehouse Lead', 'Laguna Warehouse', 155),
        ('demo.user13', 'denise.yu@northwindph.test', 'Denise Yu', @UserRole, 'Accounting', '+63 917 555 0213', 'Billing Analyst', 'Head Office - Makati', 150),
        ('demo.user14', 'rj.fernandez@northwindph.test', 'Rafael John Fernandez', @UserRole, 'Operations', '+63 917 555 0214', 'Dispatch Planner', 'Laguna Warehouse', 145),
        ('demo.user15', 'camille.tan@northwindph.test', 'Camille Tan', @UserRole, 'Sales', '+63 917 555 0215', 'Key Accounts Associate', 'Cebu Branch', 140)
    ) v(username, email, full_name, role_id, department, phone, position, branch, age_days)
    WHERE NOT EXISTS (SELECT 1 FROM Users u WHERE u.username = v.username OR u.email = v.email);

    DECLARE @AdminUser INT = (SELECT user_id FROM Users WHERE username = 'demo.admin1');
    DECLARE @StaffUser INT = (SELECT user_id FROM Users WHERE username = 'demo.staff1');

    -- Assets: 50 records across locations/statuses.
    DECLARE @Assets TABLE (
        rn INT IDENTITY(1,1),
        asset_tag NVARCHAR(50),
        asset_name NVARCHAR(150),
        category_name NVARCHAR(100),
        brand NVARCHAR(100),
        model NVARCHAR(100),
        serial_number NVARCHAR(100),
        status NVARCHAR(30),
        assignee_username NVARCHAR(50) NULL,
        department NVARCHAR(100),
        location NVARCHAR(150),
        purchase_date DATE,
        warranty_expiry DATE,
        supplier NVARCHAR(150),
        notes NVARCHAR(MAX)
    );

    INSERT INTO @Assets (asset_tag, asset_name, category_name, brand, model, serial_number, status, assignee_username, department, location, purchase_date, warranty_expiry, supplier, notes)
    VALUES
        ('AST-2026-0001','Dell Latitude 5440','Laptop','Dell','Latitude 5440','DL5440-PH-0001','Assigned','demo.user1','Finance','Head Office - Makati','2025-03-10','2028-03-10','Accent Micro Technologies','Finance analyst daily workstation'),
        ('AST-2026-0002','Lenovo ThinkPad E14','Laptop','Lenovo','ThinkPad E14 Gen 5','TP-E14-0002','Assigned','demo.user2','Operations','Cebu Branch','2025-02-18','2028-02-18','Lenovo PH Partner','Operations supervisor laptop'),
        ('AST-2026-0003','HP ProBook 440','Laptop','HP','ProBook 440 G10','HP440-0003','Assigned','demo.user3','HR','Head Office - Makati','2025-04-12','2028-04-12','HP Authorized Reseller','HR shared laptop'),
        ('AST-2026-0004','MacBook Air M2','Laptop','Apple','MacBook Air M2','MBA-M2-0004','Assigned','demo.user4','Sales','Davao Branch','2025-06-01','2027-06-01','Power Mac Center','Sales presentation laptop'),
        ('AST-2026-0005','Acer TravelMate P2','Laptop','Acer','TravelMate P2','TMP2-0005','Assigned','demo.user5','Accounting','Head Office - Makati','2024-11-20','2027-11-20','Acer PH','Accounting workstation'),
        ('AST-2026-0006','Dell OptiPlex 7010','Desktop','Dell','OptiPlex 7010','OP7010-0006','Assigned','demo.user6','Warehouse','Laguna Warehouse','2024-09-15','2027-09-15','Accent Micro Technologies','Inventory station'),
        ('AST-2026-0007','HP EliteDesk 800','Desktop','HP','EliteDesk 800 G9','ED800-0007','Assigned','demo.user7','Admin Office','Cebu Branch','2024-10-12','2027-10-12','HP Authorized Reseller','Admin desk unit'),
        ('AST-2026-0008','Lenovo ThinkCentre M70q','Desktop','Lenovo','ThinkCentre M70q','TCM70-0008','Assigned','demo.user8','Operations','Davao Branch','2024-08-08','2027-08-08','Lenovo PH Partner','Branch operations terminal'),
        ('AST-2026-0009','Dell 24 Monitor','Monitor','Dell','P2422H','MON-DL-0009','Assigned','demo.user9','Sales','Head Office - Makati','2025-01-22','2028-01-22','PC Express','Sales dual monitor'),
        ('AST-2026-0010','LG 27 Monitor','Monitor','LG','27MP400','MON-LG-0010','Assigned','demo.user10','Finance','Head Office - Makati','2025-01-23','2028-01-23','Octagon','Treasury monitor'),
        ('AST-2026-0011','Epson EcoTank Printer','Printer','Epson','L6270','EPS-L6270-0011','Available',NULL,'Admin Office','Head Office - Makati','2024-12-10','2027-12-10','Epson Philippines','Spare admin printer'),
        ('AST-2026-0012','Brother Laser Printer','Printer','Brother','HL-L2375DW','BR-HL2375-0012','Available',NULL,'Accounting','Head Office - Makati','2024-05-19','2027-05-19','Brother PH','Backup billing printer'),
        ('AST-2026-0013','Cisco ISR Router','Router','Cisco','ISR 1100','RTR-CIS-0013','Assigned','demo.staff3','IT','Head Office - Makati','2024-07-01','2027-07-01','Cisco Partner','Primary office router'),
        ('AST-2026-0014','MikroTik Branch Router','Router','MikroTik','RB4011','RTR-MKT-0014','Assigned','demo.staff3','IT','Cebu Branch','2024-07-04','2027-07-04','NetworkLabs PH','Cebu internet gateway'),
        ('AST-2026-0015','Ubiquiti EdgeRouter','Router','Ubiquiti','EdgeRouter 4','RTR-UBQ-0015','Under Repair',NULL,'IT','Davao Branch','2024-06-15','2027-06-15','Ubiquiti Distributor','Intermittent WAN port'),
        ('AST-2026-0016','Cisco Catalyst Switch','Switch','Cisco','Catalyst 2960X','SW-CAT-0016','Assigned','demo.staff3','IT','Head Office - Makati','2024-06-30','2027-06-30','Cisco Partner','Core access switch'),
        ('AST-2026-0017','TP-Link 24-Port Switch','Switch','TP-Link','TL-SG1024D','SW-TPL-0017','Available',NULL,'IT','Laguna Warehouse','2025-02-01','2028-02-01','PC Express','Warehouse spare switch'),
        ('AST-2026-0018','APC UPS 1000VA','UPS','APC','BX1000M','UPS-APC-0018','Assigned','demo.user12','Warehouse','Laguna Warehouse','2024-03-21','2027-03-21','APC Partner','Server rack UPS'),
        ('AST-2026-0019','CyberPower UPS 650VA','UPS','CyberPower','UT650EG','UPS-CYP-0019','Available',NULL,'IT','Head Office - Makati','2025-01-14','2028-01-14','Octagon','HelpDesk spare UPS'),
        ('AST-2026-0020','Hikvision Dome CCTV','CCTV','Hikvision','DS-2CD2143G0','CCTV-HIK-0020','Assigned','demo.staff4','Admin Office','Head Office - Makati','2024-04-02','2027-04-02','SecurePro Systems','Lobby CCTV'),
        ('AST-2026-0021','Dahua CCTV NVR','CCTV','Dahua','NVR4216','CCTV-DAH-0021','Assigned','demo.staff4','Admin Office','Laguna Warehouse','2024-04-03','2027-04-03','SecurePro Systems','Warehouse camera recorder'),
        ('AST-2026-0022','Sunmi POS Terminal','POS','Sunmi','T2 Mini','POS-SUN-0022','Assigned','demo.user14','Operations','Laguna Warehouse','2024-11-07','2027-11-07','POSTech Philippines','Dispatch counter POS'),
        ('AST-2026-0023','Epson POS Printer','POS','Epson','TM-T82III','POS-EPS-0023','Available',NULL,'Sales','Cebu Branch','2025-03-03','2028-03-03','POSTech Philippines','Spare receipt printer'),
        ('AST-2026-0024','Samsung Galaxy Tab A9','Mobile Device','Samsung','Galaxy Tab A9','TAB-A9-0024','Assigned','demo.user15','Sales','Cebu Branch','2025-02-11','2027-02-11','Samsung Business','Sales field tablet'),
        ('AST-2026-0025','iPhone SE Field Unit','Mobile Device','Apple','iPhone SE 3rd Gen','IPH-SE-0025','Assigned','demo.user11','HR','Cebu Branch','2024-12-01','2026-12-01','Globe Business','HR hotline phone'),
        ('AST-2026-0026','Visitor Laptop 01','Laptop','Dell','Latitude 3420','VIS-LT-0026','Assigned','demo.user13','Accounting','Head Office - Makati','2023-09-10','2026-09-10','Dell Partner','Borrowed by audit consultant until project close'),
        ('AST-2026-0027','Visitor Laptop 02','Laptop','Lenovo','ThinkPad L14','VIS-LT-0027','Assigned','demo.user14','Operations','Laguna Warehouse','2023-09-11','2026-09-11','Lenovo PH Partner','Temporary device for warehouse rollout'),
        ('AST-2026-0028','Meeting Room Projector','Monitor','Epson','EB-X49','PRJ-EPS-0028','Available',NULL,'Admin Office','Head Office - Makati','2024-01-05','2027-01-05','Epson Philippines','Borrowable projector for trainings'),
        ('AST-2026-0029','QA Test Laptop','Laptop','Acer','Aspire 5','QA-LT-0029','Available',NULL,'IT','Head Office - Makati','2023-12-19','2026-12-19','Acer PH','Temporary testing device'),
        ('AST-2026-0030','Temporary Android Scanner','Mobile Device','Zebra','TC21','ZBR-TC21-0030','Assigned','demo.user6','Warehouse','Laguna Warehouse','2024-02-12','2027-02-12','Zebra Partner','Borrowed scanner for inventory count'),
        ('AST-2026-0031','Returned Dell Laptop','Laptop','Dell','Latitude 3410','RET-DL-0031','Returned',NULL,'IT','Head Office - Makati','2022-10-10','2025-10-10','Dell Partner','Returned from Finance, awaiting inspection'),
        ('AST-2026-0032','Returned HP Laptop','Laptop','HP','ProBook 430 G8','RET-HP-0032','Returned',NULL,'IT','Cebu Branch','2022-11-14','2025-11-14','HP Authorized Reseller','Returned from HR onboarding pool'),
        ('AST-2026-0033','Pulled Out POS Terminal','POS','Sunmi','V2 Pro','PULL-POS-0033','Returned',NULL,'Operations','Davao Branch','2022-04-07','2025-04-07','POSTech Philippines','Pulled out after branch counter redesign'),
        ('AST-2026-0034','Retired Desktop Unit','Desktop','HP','Compaq 8300','RETIR-DSK-0034','Retired',NULL,'IT','Head Office - Makati','2020-06-01','2023-06-01','Legacy Supplier','Retired due to hardware age'),
        ('AST-2026-0035','Retired Monitor','Monitor','Samsung','S22F350','RETIR-MON-0035','Retired',NULL,'IT','Cebu Branch','2020-07-12','2023-07-12','Octagon','Retired after panel failure'),
        ('AST-2026-0036','For Inspection Laptop','Laptop','Lenovo','ThinkPad E15','INSP-LT-0036','Returned',NULL,'IT','Head Office - Makati','2023-08-20','2026-08-20','Lenovo PH Partner','Returned with battery swelling report; pending inspection'),
        ('AST-2026-0037','Repair Printer','Printer','Canon','G7070','REP-CAN-0037','Under Repair',NULL,'Admin Office','Cebu Branch','2024-03-08','2027-03-08','Canon PH','Paper feed assembly replacement'),
        ('AST-2026-0038','Repair Laptop','Laptop','Dell','Vostro 3520','REP-DL-0038','Under Repair',NULL,'IT','Davao Branch','2024-02-28','2027-02-28','Dell Partner','Keyboard replacement'),
        ('AST-2026-0039','Spare Monitor A','Monitor','AOC','24B2XH','MON-AOC-0039','Available',NULL,'IT','Head Office - Makati','2025-05-10','2028-05-10','PC Express','New spare monitor'),
        ('AST-2026-0040','Spare Monitor B','Monitor','ViewSonic','VA2432','MON-VS-0040','Available',NULL,'IT','Cebu Branch','2025-05-11','2028-05-11','PC Express','New spare monitor'),
        ('AST-2026-0041','Finance Laptop Spare','Laptop','HP','EliteBook 640','SP-HP-0041','Available',NULL,'Finance','Head Office - Makati','2025-04-05','2028-04-05','HP Authorized Reseller','Spare Finance laptop'),
        ('AST-2026-0042','Warehouse Desktop Spare','Desktop','Lenovo','ThinkCentre M75q','SP-LEN-0042','Available',NULL,'Warehouse','Laguna Warehouse','2025-04-06','2028-04-06','Lenovo PH Partner','Spare receiving station'),
        ('AST-2026-0043','Admin Office Laptop','Laptop','Asus','ExpertBook B1','ASUS-B1-0043','Assigned','demo.user7','Admin Office','Cebu Branch','2024-09-22','2027-09-22','Asus Business Partner','Admin assistant laptop'),
        ('AST-2026-0044','Sales Demo Tablet','Mobile Device','Apple','iPad 10th Gen','IPAD-0044','Assigned','demo.user9','Sales','Head Office - Makati','2025-01-30','2027-01-30','Power Mac Center','Sales demo tablet'),
        ('AST-2026-0045','Warehouse Label Printer','Printer','Zebra','ZD421','ZBR-ZD421-0045','Assigned','demo.user12','Warehouse','Laguna Warehouse','2024-10-03','2027-10-03','Zebra Partner','Label printing station'),
        ('AST-2026-0046','HR Interview Laptop','Laptop','Lenovo','ThinkBook 14','TB14-0046','Assigned','demo.user11','HR','Cebu Branch','2024-08-14','2027-08-14','Lenovo PH Partner','Interview room laptop'),
        ('AST-2026-0047','Accounting Scanner PC','Desktop','Dell','OptiPlex 3000','OP3000-0047','Assigned','demo.user13','Accounting','Head Office - Makati','2024-12-18','2027-12-18','Dell Partner','Document scanning PC'),
        ('AST-2026-0048','Operations Dispatch Laptop','Laptop','HP','ProBook 450 G9','PB450-0048','Assigned','demo.user8','Operations','Davao Branch','2024-11-11','2027-11-11','HP Authorized Reseller','Dispatch team laptop'),
        ('AST-2026-0049','Sales Roadshow Projector','Monitor','BenQ','MS560','PRJ-BNQ-0049','Assigned','demo.user4','Sales','Davao Branch','2023-10-30','2026-10-30','BenQ Partner','Borrowed roadshow projector'),
        ('AST-2026-0050','Network Lab Switch','Switch','Netgear','GS724T','LAB-SW-0050','Available',NULL,'IT','Head Office - Makati','2024-05-25','2027-05-25','NetworkLabs PH','Test bench switch');

    INSERT INTO assets (asset_tag, asset_name, category_id, brand, model, serial_number, status, assigned_to, department, location, purchase_date, warranty_expiry, supplier, notes, created_at, updated_at)
    SELECT a.asset_tag, a.asset_name, ac.category_id, a.brand, a.model, a.serial_number, a.status,
           u.user_id, a.department, a.location, a.purchase_date, a.warranty_expiry, a.supplier, a.notes,
           DATEADD(day, -260 + a.rn, @Now), DATEADD(day, -30 + (a.rn % 20), @Now)
    FROM @Assets a
    JOIN asset_categories ac ON ac.category_name = a.category_name
    LEFT JOIN Users u ON u.username = a.assignee_username
    WHERE NOT EXISTS (SELECT 1 FROM assets existing WHERE existing.asset_tag = a.asset_tag);

    -- Assignment/deployment history, including returned and borrowed scenarios.
    INSERT INTO asset_assignments (asset_id, assigned_to, assigned_by, department, location, assigned_at, returned_at, return_status, return_condition, notes, return_notes, created_at, updated_at)
    SELECT asset.asset_id, u.user_id, @AdminUser, a.department, a.location,
           DATEADD(day, -210 + a.rn, @Now),
           CASE WHEN a.status IN ('Returned','For Inspection','Pulled Out','Retired') THEN DATEADD(day, -20 + (a.rn % 12), @Now) ELSE NULL END,
           CASE WHEN a.status IN ('Returned','For Inspection','Pulled Out','Retired') THEN CASE WHEN a.status = 'Pulled Out' THEN 'Pulled Out' ELSE 'Returned' END ELSE NULL END,
           CASE WHEN a.status IN ('Returned','For Inspection') THEN 'Returned with minor cosmetic wear; pending IT validation.' WHEN a.status = 'Pulled Out' THEN 'Pulled out from branch counter.' ELSE NULL END,
           CASE WHEN a.asset_tag IN ('AST-2026-0026','AST-2026-0027','AST-2026-0030','AST-2026-0049') THEN 'Borrow record: temporary device issued for project, visitor, audit, or roadshow use.' ELSE 'Initial deployment record.' END,
           CASE WHEN a.status IN ('Returned','For Inspection','Pulled Out','Retired') THEN 'Received by IT asset custodian.' ELSE NULL END,
           DATEADD(day, -210 + a.rn, @Now), DATEADD(day, -20 + (a.rn % 12), @Now)
    FROM @Assets a
    JOIN assets asset ON asset.asset_tag = a.asset_tag
    JOIN Users u ON u.username = COALESCE(a.assignee_username, 'demo.user1')
    WHERE NOT EXISTS (
        SELECT 1 FROM asset_assignments aa
        WHERE aa.asset_id = asset.asset_id
          AND (
              aa.notes = 'Initial deployment record.'
              OR aa.notes = 'Borrow record: temporary device issued for project, visitor, audit, or roadshow use.'
          )
    );

    -- Maintenance history
    INSERT INTO asset_maintenance_logs (asset_id, maintenance_type, description, performed_by, vendor, cost, maintenance_date, next_maintenance_date, status, notes, created_at, updated_at)
    SELECT asset.asset_id, v.maintenance_type, v.description, v.performed_by, v.vendor, v.cost,
           DATEADD(day, -v.days_ago, @Now), DATEADD(day, 120 - (v.days_ago % 30), @Now), v.status, v.notes,
           DATEADD(day, -v.days_ago, @Now), DATEADD(day, -v.days_ago + 1, @Now)
    FROM (VALUES
        ('AST-2026-0015','Repair','Diagnosed unstable WAN port and replaced patch module.', @StaffUser, 'NetworkLabs PH', 1850.00, 22, 'In Progress', 'Awaiting final burn-in test.'),
        ('AST-2026-0037','Repair','Paper feed roller replacement and printer head cleaning.', @StaffUser, 'Canon Service Center', 3200.00, 18, 'In Progress', 'Parts ordered.'),
        ('AST-2026-0038','Repair','Keyboard replacement and BIOS update.', @StaffUser, 'Dell Partner Service', 2800.00, 12, 'In Progress', 'Unit under warranty verification.'),
        ('AST-2026-0036','Inspection','Battery swelling inspection after return.', @StaffUser, 'Internal IT', 0.00, 9, 'Scheduled', 'Do not redeploy until battery is cleared.'),
        ('AST-2026-0001','Cleaning','Quarterly keyboard, vents, and screen cleaning.', @StaffUser, 'Internal IT', 0.00, 95, 'Completed', 'No issue found.'),
        ('AST-2026-0013','Maintenance','Firmware update and configuration backup.', @StaffUser, 'Internal IT', 0.00, 70, 'Completed', 'Config stored in secure repository.'),
        ('AST-2026-0045','Replacement','Replaced worn label printer cutter assembly.', @StaffUser, 'Zebra Partner', 1450.00, 54, 'Completed', 'Print quality restored.'),
        ('AST-2026-0020','Inspection','CCTV angle and recording retention inspection.', @StaffUser, 'SecurePro Systems', 900.00, 42, 'Completed', 'Recording retention verified.')
    ) v(asset_tag, maintenance_type, description, performed_by, vendor, cost, days_ago, status, notes)
    JOIN assets asset ON asset.asset_tag = v.asset_tag
    WHERE NOT EXISTS (
        SELECT 1 FROM asset_maintenance_logs aml
        WHERE aml.asset_id = asset.asset_id AND aml.description = v.description
    );

    -- Tickets: 100 realistic tickets across last 12 months.
    DECLARE @i INT = 1;
    WHILE @i <= 100
    BEGIN
        DECLARE @TicketNumber NVARCHAR(20) = CONCAT('TKT-2026-', FORMAT(@i, '0000'));
        DECLARE @Creator INT = (SELECT user_id FROM Users WHERE username = CONCAT('demo.user', ((@i - 1) % 15) + 1));
        DECLARE @Assignee INT = CASE WHEN @i % 10 IN (0, 7) THEN NULL ELSE (SELECT user_id FROM Users WHERE username = CONCAT('demo.staff', ((@i - 1) % 5) + 1)) END;
        DECLARE @CategoryName NVARCHAR(100) = CASE @i % 6
            WHEN 0 THEN 'Hardware Issue'
            WHEN 1 THEN 'Software Issue'
            WHEN 2 THEN 'Network Issue'
            WHEN 3 THEN 'Account Access'
            WHEN 4 THEN 'Asset Request'
            ELSE 'General Inquiry'
        END;
        DECLARE @Status NVARCHAR(20) = CASE
            WHEN @i % 12 = 0 THEN 'Open'
            WHEN @i % 12 IN (1,2) THEN 'In Progress'
            WHEN @i % 12 IN (3,4,5,6) THEN 'Resolved'
            ELSE 'Closed'
        END;
        DECLARE @Priority NVARCHAR(20) = CASE
            WHEN @i % 17 = 0 THEN 'Urgent'
            WHEN @i % 5 = 0 THEN 'High'
            WHEN @i % 3 = 0 THEN 'Low'
            ELSE 'Normal'
        END;
        DECLARE @CreatedAt DATETIME = DATEADD(day, -((@i * 3) % 365), DATEADD(hour, 8 + (@i % 9), CAST(CAST(@Now AS DATE) AS DATETIME)));
        DECLARE @DueDate DATETIME = DATEADD(day, CASE WHEN @i % 11 = 0 THEN -2 ELSE 3 + (@i % 7) END, @CreatedAt);
        DECLARE @ResolvedAt DATETIME = CASE WHEN @Status IN ('Resolved','Closed') THEN DATEADD(day, 1 + (@i % 5), @CreatedAt) ELSE NULL END;
        DECLARE @Title NVARCHAR(255) = CASE @CategoryName
            WHEN 'Hardware Issue' THEN CASE @i % 4 WHEN 0 THEN 'Laptop running hot during daily work' WHEN 1 THEN 'Printer not feeding paper properly' WHEN 2 THEN 'Monitor flickering intermittently' ELSE 'Keyboard keys not responding' END
            WHEN 'Software Issue' THEN CASE @i % 4 WHEN 0 THEN 'Microsoft Office activation prompt' WHEN 1 THEN 'ERP client error on startup' WHEN 2 THEN 'PDF files opening slowly' ELSE 'VPN client requires reinstall' END
            WHEN 'Network Issue' THEN CASE @i % 4 WHEN 0 THEN 'Slow Wi-Fi in conference room' WHEN 1 THEN 'LAN port has no connection' WHEN 2 THEN 'Branch internet intermittent' ELSE 'Unable to connect to VPN' END
            WHEN 'Account Access' THEN CASE @i % 4 WHEN 0 THEN 'Password reset request' WHEN 1 THEN 'Email mailbox access request' WHEN 2 THEN 'ERP role access update' ELSE 'New shared drive permission' END
            WHEN 'Asset Request' THEN CASE @i % 4 WHEN 0 THEN 'Request for spare laptop' WHEN 1 THEN 'Temporary projector reservation' WHEN 2 THEN 'Need additional monitor' ELSE 'Request for barcode scanner' END
            ELSE CASE @i % 4 WHEN 0 THEN 'Question about IT equipment policy' WHEN 1 THEN 'Need assistance with meeting room setup' WHEN 2 THEN 'Follow-up on previous support request' ELSE 'General HelpDesk inquiry' END
        END;
        DECLARE @Description NVARCHAR(MAX) = CONCAT('Demo ticket created for ', @CategoryName, '. Reported by business user for realistic dashboard, report, search, and pagination testing. Reference batch item ', @i, '.');
        DECLARE @Department NVARCHAR(100) = (SELECT department FROM Users WHERE user_id = @Creator);
        DECLARE @Resolution NVARCHAR(MAX) = CASE WHEN @Status IN ('Resolved','Closed') THEN 'Issue validated, corrective action completed, and user confirmed service restored.' ELSE NULL END;

        IF NOT EXISTS (SELECT 1 FROM Tickets WHERE ticket_number = @TicketNumber)
        BEGIN
            INSERT INTO Tickets (ticket_number, title, description, category_id, priority, status, created_by, assigned_to, department, resolution_notes, created_at, updated_at, resolved_at, due_date)
            VALUES (@TicketNumber, @Title, @Description, (SELECT TOP 1 category_id FROM Categories WHERE category_name = @CategoryName ORDER BY category_id), @Priority, @Status, @Creator, @Assignee, @Department, @Resolution, @CreatedAt, DATEADD(day, 1 + (@i % 9), @CreatedAt), @ResolvedAt, @DueDate);

            DECLARE @TicketId INT = SCOPE_IDENTITY();
            DECLARE @LinkedAssetId INT = CASE WHEN @i % 4 <> 0 THEN (SELECT asset_id FROM assets WHERE asset_tag = CONCAT('AST-2026-', FORMAT(((@i - 1) % 50) + 1, '0000'))) ELSE NULL END;

            IF @LinkedAssetId IS NOT NULL
            BEGIN
                INSERT INTO ticket_assets (ticket_id, asset_id, linked_by, linked_at)
                VALUES (@TicketId, @LinkedAssetId, COALESCE(@Assignee, @AdminUser), DATEADD(hour, 1, @CreatedAt));
            END;

            INSERT INTO TicketComments (ticket_id, user_id, comment, is_internal, created_at)
            VALUES
                (@TicketId, @Creator, 'Hi IT team, please check this when available. I added the details I observed from my end.', 0, DATEADD(minute, 15, @CreatedAt)),
                (@TicketId, COALESCE(@Assignee, @AdminUser), 'Acknowledged. We are checking the reported issue and will update this ticket after validation.', CASE WHEN @i % 5 = 0 THEN 1 ELSE 0 END, DATEADD(hour, 3, @CreatedAt));

            IF @Status IN ('Resolved','Closed')
            BEGIN
                INSERT INTO TicketComments (ticket_id, user_id, comment, is_internal, created_at)
                VALUES (@TicketId, COALESCE(@Assignee, @AdminUser), 'Resolution applied. Please monitor and reopen or create a new request if the issue returns.', 0, DATEADD(hour, 4, @ResolvedAt));
            END;

            INSERT INTO TicketHistory (ticket_id, changed_by, field_changed, old_value, new_value, changed_at)
            VALUES
                (@TicketId, @Creator, 'status', NULL, 'Open', @CreatedAt),
                (@TicketId, COALESCE(@Assignee, @AdminUser), 'assigned_to', 'Unassigned', COALESCE(CONVERT(NVARCHAR(20), @Assignee), 'Unassigned'), DATEADD(hour, 1, @CreatedAt));

            IF @Status <> 'Open'
            BEGIN
                INSERT INTO TicketHistory (ticket_id, changed_by, field_changed, old_value, new_value, changed_at)
                VALUES (@TicketId, COALESCE(@Assignee, @AdminUser), 'status', 'Open', @Status, DATEADD(day, 1, @CreatedAt));
            END;
        END;

        SET @i += 1;
    END;

    -- Asset activity logs: deployments, returns, repairs, pull-outs, and borrow actions.
    INSERT INTO asset_activity_logs (asset_id, action, old_value, new_value, changed_by, created_at)
    SELECT asset.asset_id, v.action, v.old_value, v.new_value, v.changed_by, DATEADD(day, -v.days_ago, @Now)
    FROM (VALUES
        ('AST-2026-0001','Asset assigned',NULL,'demo.user1',@AdminUser,120,'TKT-2026-0001'),
        ('AST-2026-0002','Asset assigned',NULL,'demo.user2',@AdminUser,118,'TKT-2026-0002'),
        ('AST-2026-0031','Asset returned','demo.user1','Returned',@StaffUser,15,'TKT-2026-0031'),
        ('AST-2026-0032','Asset returned','demo.user3','Returned',@StaffUser,9,'TKT-2026-0032'),
        ('AST-2026-0036','Asset returned for inspection','Assigned','For Inspection',@StaffUser,8,'TKT-2026-0036'),
        ('AST-2026-0015','Asset sent for repair','Assigned','Under Repair',@StaffUser,22,'TKT-2026-0015'),
        ('AST-2026-0037','Asset sent for repair','Available','Under Repair',@StaffUser,18,'TKT-2026-0037'),
        ('AST-2026-0033','Asset pulled out','Assigned','Pulled Out',@AdminUser,30,'TKT-2026-0033'),
        ('AST-2026-0026','Asset borrowed','Available','Borrowed by audit consultant',@AdminUser,40,'TKT-2026-0026'),
        ('AST-2026-0027','Asset borrowed','Available','Borrowed for warehouse rollout',@AdminUser,36,'TKT-2026-0027'),
        ('AST-2026-0028','Borrow reservation','Available','Reserved for leadership training',@StaffUser,12,'TKT-2026-0028'),
        ('AST-2026-0030','Asset borrowed','Available','Temporary inventory scanner',@StaffUser,28,'TKT-2026-0030'),
        ('AST-2026-0049','Asset borrowed','Available','Sales roadshow projector',@StaffUser,55,'TKT-2026-0049'),
        ('AST-2026-0045','Maintenance completed','Repair','Label cutter replaced',@StaffUser,54,'TKT-2026-0045'),
        ('AST-2026-0013','Maintenance completed','Firmware old','Firmware updated',@StaffUser,70,'TKT-2026-0013')
    ) v(asset_tag, action, old_value, new_value, changed_by, days_ago, ticket_number)
    JOIN assets asset ON asset.asset_tag = v.asset_tag
    WHERE NOT EXISTS (
        SELECT 1 FROM asset_activity_logs aal
        WHERE aal.asset_id = asset.asset_id
          AND aal.action = v.action
          AND ISNULL(aal.new_value, '') = ISNULL(v.new_value, '')
    );

    -- General activity logs for dashboard/activity-log testing.
    INSERT INTO ActivityLogs (user_id, user_name, user_role, action, module, record_id, details, created_at)
    SELECT u.user_id, u.full_name, r.role_name, v.action, v.module, v.record_id, v.details, DATEADD(day, -v.days_ago, @Now)
    FROM (VALUES
        ('demo.admin1','Asset created','Assets','AST-2026-0001','{"source":"demo seed","status":"Assigned"}',120),
        ('demo.staff1','Asset returned','Assets','AST-2026-0031','{"return_status":"Returned"}',15),
        ('demo.staff1','Asset sent for repair','Assets','AST-2026-0015','{"status":"Under Repair"}',22),
        ('demo.admin1','Asset marked as available','Assets','AST-2026-0019','{"from":"Returned","to":"Available"}',11),
        ('demo.staff2','Ticket assigned','Tickets','TKT-2026-0008','{"queue":"HelpDesk"}',83),
        ('demo.staff3','Ticket status changed','Tickets','TKT-2026-0017','{"from":"Open","to":"Resolved"}',64),
        ('demo.admin2','User updated','Users','demo.user5','{"field":"branch"}',51),
        ('demo.superadmin','Database backup created','System','demo-backup','{"type":"manual"}',7)
    ) v(username, action, module, record_id, details, days_ago)
    JOIN Users u ON u.username = v.username
    JOIN Roles r ON r.role_id = u.role_id
    WHERE NOT EXISTS (
        SELECT 1 FROM ActivityLogs al
        WHERE al.action = v.action AND al.module = v.module AND al.record_id = v.record_id
    );

    -- Notifications for unread/read UI testing.
    INSERT INTO Notifications (user_id, title, message, type, module, record_id, related_ticket_id, related_asset_id, link_target, is_read, created_at)
    SELECT u.user_id, v.title, v.message, v.type, v.module, v.record_id, t.ticket_id, asset.asset_id, lt.link_target, v.is_read, DATEADD(day, -v.days_ago, @Now)
    FROM (VALUES
        ('demo.user1','Ticket update','Your laptop heat issue ticket was updated.','ticket_update','Tickets',1,'TKT-2026-0001',NULL,'ticket:',0,2),
        ('demo.user3','Asset returned','Your returned HR laptop was received by IT.','asset_return','Assets',32,NULL,'AST-2026-0032','asset:',0,5),
        ('demo.staff1','New assignment','A hardware ticket was assigned to your queue.','ticket_assignment','Tickets',12,'TKT-2026-0012',NULL,'ticket:',1,8),
        ('demo.admin1','Repair update','Router repair ticket requires review.','asset_repair','Assets',15,'TKT-2026-0015','AST-2026-0015','asset:',0,3)
    ) v(username, title, message, type, module, record_id, ticket_number, asset_tag, link_prefix, is_read, days_ago)
    JOIN Users u ON u.username = v.username
    LEFT JOIN Tickets t ON t.ticket_number = v.ticket_number
    LEFT JOIN assets asset ON asset.asset_tag = v.asset_tag
    CROSS APPLY (SELECT CASE WHEN v.ticket_number IS NOT NULL THEN CONCAT('ticket:', t.ticket_id) WHEN v.asset_tag IS NOT NULL THEN CONCAT('asset:', asset.asset_id) ELSE NULL END AS link_target) lt
    WHERE NOT EXISTS (
        SELECT 1 FROM Notifications n
        WHERE n.user_id = u.user_id AND n.title = v.title AND n.message = v.message
    );

    COMMIT TRANSACTION;
    PRINT 'Demo seed data inserted successfully.';
    PRINT 'Demo user password: Admin@123';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();
    RAISERROR(@Err, 16, 1);
END CATCH;
GO
