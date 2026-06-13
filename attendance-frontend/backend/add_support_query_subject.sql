USE Shivamgiri;

ALTER TABLE SupportQueries
ADD COLUMN QuerySubject VARCHAR(255) NOT NULL DEFAULT 'General Query'
AFTER ManagerUniqueCode;
