-- Basic SLA/KPI tracking migration
-- Adds the acknowledged timestamp used for acknowledgement-time KPI tracking.

IF OBJECT_ID('dbo.Tickets', 'U') IS NOT NULL
    AND COL_LENGTH('dbo.Tickets', 'acknowledged_at') IS NULL
BEGIN
    ALTER TABLE Tickets ADD acknowledged_at DATETIME NULL;
END
GO
