SELECT u.name, d.name AS dept_name
FROM users u
JOIN departments d ON u.dept_id = d.id
WHERE u.age > 30;
