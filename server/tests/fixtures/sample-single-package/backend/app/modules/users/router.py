from app.modules.users.repository import list_users
from fastapi import APIRouter

router = APIRouter()
users = list_users
