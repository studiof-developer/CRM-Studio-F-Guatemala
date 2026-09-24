-- Remove automatic line 1 (Studio F Virtual) assignment for advisors who are explicitly assigned to another line (e.g. Basshert Zacapa)
DELETE FROM user_whatsapp_numbers 
WHERE whatsapp_number_id = (SELECT id FROM whatsapp_numbers WHERE label = 'Studio F Virtual' OR id = 1 LIMIT 1)
  AND user_id IN (
    SELECT u.id FROM users u
    JOIN user_whatsapp_numbers uwn ON u.id = uwn.user_id
    WHERE u.role = 'asesor'
      AND uwn.whatsapp_number_id != (SELECT id FROM whatsapp_numbers WHERE label = 'Studio F Virtual' OR id = 1 LIMIT 1)
  );
