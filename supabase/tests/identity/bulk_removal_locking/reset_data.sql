truncate identity_deletion_requests, identity_lifecycle_actions, hr_employees, users cascade;
insert into users(id) values
 ('00000000-0000-0000-0000-00000000000a'),
 ('00000000-0000-0000-0000-00000000000b'),
 ('00000000-0000-0000-0000-00000000000c'),
 ('00000000-0000-0000-0000-00000000000d');
insert into hr_employees(user_id) select id from users;
